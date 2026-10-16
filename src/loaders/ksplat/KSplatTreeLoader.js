import {KSplatHeader, SplatBuffer} from '../SplatBuffer.js';
import { fetchWithProgress, delayedExecute, nativePromiseWithExtractedComponents } from '../../Util.js';
import { LoaderStatus } from '../LoaderStatus.js';
import { Constants } from '../../Constants.js';
import * as THREE from "three";
import {SplatTreeNode, SplatSubTree} from "../../splattree/SplatTree.js";
import {ITiledSplatFileLoader} from '../TiledSplatFileLoader.js'
import {SplatDataPacking} from "../../LOD/SplatDataPacking.js";
import {DEFAULT_NODE_ALLOCATION} from "../../LOD/GPUSplatAllocator.js";
import {StreamingMode} from "../StreamingMode.js";



export class KSplatTreeBuffer {
    constructor(splatBuffer, subTree) {
        const ksplatBuffer = splatBuffer.bufferData;
        const treeBuffer = KSplatTreeBuffer.serializeOctreeToBuffer(subTree);

        const splatBufferByteLength = KSplatHeader.calculateTotalSplatBufferSize(splatBuffer);
        console.log("TREE STORE OFFSET", splatBufferByteLength)

        const totalByteLength = splatBufferByteLength + treeBuffer.byteLength;

        this.bufferData = new ArrayBuffer(totalByteLength);
        const finalView = new Uint8Array(this.bufferData);

        const view1 = new Uint8Array(ksplatBuffer);
        const view2 = new Uint8Array(treeBuffer);

        // Copy the splats to the start of the buffer and the tree to the end
        finalView.set(view1, 0);
        finalView.set(view2, splatBufferByteLength);
    }

    static serializeOctreeToBuffer(subTree) {
        const treeRoot = subTree.rootNode;
        const nodes = [];
        const nodeToIdMap = new Map();

        function traverse(node) {
            if (!node) return;
            nodeToIdMap.set(node, nodes.length);
            nodes.push(node);
            if (node.children) {
                for (const child of node.children) {
                    traverse(child);
                }
            }
        }
        traverse(treeRoot);

        const nodeCount = nodes.length;
        const bytesPerInt = 4;

        console.log("Serializing", nodeCount)


        // 1 Int (total node count) + 6 Floats (BBox) + (12 Ints for each node: 4 for offsets, 8 for child ids)
        const headerElementCount = 1 + 6 + (nodeCount * 12);
        const headerByteLength = headerElementCount * bytesPerInt;

        let totalDataElements = 0;
        for (const node of nodes) {
            const indexArray = node.data && node.data.indexes ? node.data.indexes : [];
            totalDataElements += indexArray.length;
        }
        console.log("Tree buffer length:", totalDataElements);
        const totalByteLength = headerByteLength + (totalDataElements * bytesPerInt);

        const fileBuffer = new ArrayBuffer(totalByteLength);
        const view = new DataView(fileBuffer);
        const rawDataView = new Int32Array(fileBuffer);

        let byteOffset = 0;

        view.setInt32(byteOffset, nodeCount, true);
        byteOffset += 4;

        view.setFloat32(byteOffset, treeRoot.min.x, true); byteOffset += 4;
        view.setFloat32(byteOffset, treeRoot.min.y, true); byteOffset += 4;
        view.setFloat32(byteOffset, treeRoot.min.z, true); byteOffset += 4;

        view.setFloat32(byteOffset, treeRoot.max.x, true); byteOffset += 4;
        view.setFloat32(byteOffset, treeRoot.max.y, true); byteOffset += 4;
        view.setFloat32(byteOffset, treeRoot.max.z, true); byteOffset += 4;

        let currentDataByteOffset = headerByteLength;

        for (const node of nodes) {
            const jsArray = node.data && node.data.indexes ? node.data.indexes : [];

            view.setInt32(byteOffset, currentDataByteOffset, true); byteOffset += 4;
            view.setInt32(byteOffset, jsArray.length, true); byteOffset += 4;
            view.setInt32(byteOffset, node.startLocalId, true); byteOffset += 4;
            view.setInt32(byteOffset, node.endLocalId, true); byteOffset += 4;

            for (let i = 0; i < 8; i++) {
                const childNode = node.children[i];
                const childId = childNode ? nodeToIdMap.get(childNode) : -1;
                view.setInt32(byteOffset, childId, true); byteOffset += 4;
            }

            //TODO: Deprecate the index buffer saving (it will cause issues when saving multiple kstrees)
            if (jsArray.length > 0) {
                const elementOffset = currentDataByteOffset / bytesPerInt;
                rawDataView.set(new Int32Array(jsArray), elementOffset);
            }

            currentDataByteOffset += jsArray.length * bytesPerInt;
        }

        return fileBuffer;
    }


    // TODO: FOR NOW ADD OPTION TO DESERIALIZE AS TILES...
    // TODO: LATER REWORK THE TREE FORMAT
    /**
     * @param {ArrayBuffer} fileBuffer
     * @param {number} offset
     * @param {number=} streamMode //The streaming mode of the octree nodes. Defaults to Static
     */
    static deserializeOctreeBuffer(fileBuffer, offset, streamMode = StreamingMode.Static) {
        const view = new DataView(fileBuffer, offset);
        let byteOffset = 0;

        const nodeCount = view.getInt32(byteOffset, true);
        byteOffset += 4;

        const treeMin = new THREE.Vector3(
            view.getFloat32(byteOffset, true),
            view.getFloat32(byteOffset + 4, true),
            view.getFloat32(byteOffset + 8, true)
        );
        byteOffset += 12;

        const treeMax = new THREE.Vector3(
            view.getFloat32(byteOffset, true),
            view.getFloat32(byteOffset + 4, true),
            view.getFloat32(byteOffset + 8, true)
        );
        byteOffset += 12;

        const nodeDataOffsets = []
        const nodeDataList = [];
        const nodeIdToChildrenIds = [];

        for (let i = 0; i < nodeCount; i++) {
            const dataByteOffset = offset + view.getInt32(byteOffset, true); byteOffset += 4;
            const elementLength = view.getInt32(byteOffset, true); byteOffset += 4;
            const startLocalId =  view.getInt32(byteOffset, true); byteOffset += 4;
            const endLocalId = view.getInt32(byteOffset, true); byteOffset += 4;

            const childIds = [];
            for (let c = 0; c < 8; c++) {
                childIds.push(view.getInt32(byteOffset, true)); byteOffset += 4;
            }

            nodeDataOffsets.push({
                start: startLocalId,
                end: endLocalId
            });

            const nodeData = Array.from(new Int32Array(fileBuffer, dataByteOffset, elementLength));
            nodeDataList.push(nodeData);
            nodeIdToChildrenIds.push(childIds);
        }

        let allocation;
        if (streamMode === StreamingMode.Tiles) {
            allocation = {
                static: false,
                offset: -1,
                textureAllocations: null,
            }
        } else {
            allocation = DEFAULT_NODE_ALLOCATION
        }

        const processSplatTreeNode = function(node) {
            const nodeDimensions = [node.max.x - node.min.x,
                node.max.y - node.min.y,
                node.max.z - node.min.z];
            const halfDimensions = [nodeDimensions[0] * 0.5,
                nodeDimensions[1] * 0.5,
                nodeDimensions[2] * 0.5];
            const nodeCenter = [node.min.x + halfDimensions[0],
                node.min.y + halfDimensions[1],
                node.min.z + halfDimensions[2]];

            const childrenBounds = [
                // top section, clockwise from upper-left (looking from above, +Y)
                new THREE.Box3(new THREE.Vector3(nodeCenter[0] - halfDimensions[0], nodeCenter[1], nodeCenter[2] - halfDimensions[2]),
                    new THREE.Vector3(nodeCenter[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2])),
                new THREE.Box3(new THREE.Vector3(nodeCenter[0], nodeCenter[1], nodeCenter[2] - halfDimensions[2]),
                    new THREE.Vector3(nodeCenter[0] + halfDimensions[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2])),
                new THREE.Box3(new THREE.Vector3(nodeCenter[0], nodeCenter[1], nodeCenter[2]),
                    new THREE.Vector3(nodeCenter[0] + halfDimensions[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2] + halfDimensions[2])),
                new THREE.Box3(new THREE.Vector3(nodeCenter[0] - halfDimensions[0], nodeCenter[1], nodeCenter[2]),
                    new THREE.Vector3(nodeCenter[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2] + halfDimensions[2])),

                // bottom section, clockwise from lower-left (looking from above, +Y)
                new THREE.Box3(new THREE.Vector3(nodeCenter[0] - halfDimensions[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2] - halfDimensions[2]),
                    new THREE.Vector3(nodeCenter[0], nodeCenter[1], nodeCenter[2])),
                new THREE.Box3(new THREE.Vector3(nodeCenter[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2] - halfDimensions[2]),
                    new THREE.Vector3(nodeCenter[0] + halfDimensions[0], nodeCenter[1], nodeCenter[2])),
                new THREE.Box3(new THREE.Vector3(nodeCenter[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2]),
                    new THREE.Vector3(nodeCenter[0] + halfDimensions[0], nodeCenter[1], nodeCenter[2] + halfDimensions[2])),
                new THREE.Box3(new THREE.Vector3(nodeCenter[0] - halfDimensions[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2]),
                    new THREE.Vector3(nodeCenter[0], nodeCenter[1], nodeCenter[2] + halfDimensions[2])),
            ];

            const nodeChildren = nodeIdToChildrenIds[node.id];

            if (!nodeChildren || nodeChildren.length === 0) {
                return;
            }

            for (let i = 0; i < 8; i++) {
                const childId = nodeChildren[i];
                if (childId === -1) {
                    continue;
                }

                const childNode = new SplatTreeNode(childrenBounds[i].min, childrenBounds[i].max, node.level + 1, childId, allocation);
                const dataOffsets = nodeDataOffsets[0];
                //TODO: Deprecate the index buffer saving (it will cause issues when saving multiple kstrees)
                childNode.data = {
                    'indexes': nodeDataList[childId]
                };
                childNode.numSplats = nodeDataList[childId].length;
                childNode.sampled = true;
                childNode.startLocalId = dataOffsets.start;
                childNode.endLocalId = dataOffsets.end;
                node.children.push(childNode);
            }
        };

        const treeRootOffsets = nodeDataOffsets[0];
        const treeRootData = nodeDataList[0];
        const treeRoot = new SplatTreeNode(treeMin, treeMax, 0, 0, allocation);
        //TODO: Deprecate the index buffer saving (it will cause issues when saving multiple kstrees)
        treeRoot.data = {
            'indexes': treeRootData
        };
        treeRoot.numSplats = treeRootData.length;
        treeRoot.sampled = true;
        treeRoot.startLocalId = treeRootOffsets.start;
        treeRoot.endLocalId = treeRootOffsets.end;
        if (streamMode === StreamingMode.Tiles) {
            treeRoot.key = {
                x: 0,
                y: 0,
                z: 0,
            }
        }

        const queue = [treeRoot];
        while (queue.length > 0) {
            const treeNode = queue.shift();
            processSplatTreeNode(treeNode);
            queue.push(...treeNode.children);
        }

        return treeRoot;
    }

    downloadToFile(fileName) {
        const blob = new Blob([this.bufferData], {
            type: 'application/octet-stream',
        });

        const downLoadLink = document.createElement('a');
        document.body.appendChild(downLoadLink);
        downLoadLink.download = fileName;
        downLoadLink.href = URL.createObjectURL(blob);
        downLoadLink.click();
    }
}

export class KSplatTreeLoader extends ITiledSplatFileLoader {

    /**
     * TODO: Loads a SplatBuffer from a .kstree in immediate mode (the full content is loaded into memory at once)
     *  Take the url as argument instead of the full buffer
     * @param {SplatBuffer} splatBuffer Must be a .kstree SplatBuffer
     */
    constructor(splatBuffer) {
        super()

        //////////////////////////////////////////////// TEMPORARY  TODO: REMOVE and parse only the file headers !!!
        if (!splatBuffer.isKSTree) {
            this.splatBuffer = null;
            console.error("KSplatTreeLoader::constructor: Wrong SplatBuffer format. The splatBuffer must be in the .kstree format");
            return;
        }
        this.splatBuffer = splatBuffer;
        ////////////////////////////////////////////////


        //TODO: Load just the header. Its all information needed at first
        //KSplatTreeLoader.loadHeader(url)

        //TODO: Break it into smaller subtrees
        this.splatSubTree = KSplatTreeLoader.loadTree(splatBuffer);

        // A map for converting from the linearized 3D tile indexes (x + 2 * y + 4 * z) into the
        // indexing scheme of the node's children (see deserializeOctreeBuffer() above for how the children bounds are ordered)
        this.nodeIndexRemap = [
            // Bottom section nodes
            4,
            5,
            7,
            6,

            //Upper section nodes
            0,
            1,
            3,
            2
        ]
    }

    /**
     * Returns Range of splats stored in the given node, or null if the node does not exist.
     * @return {{from: number, to: number, count: number} | null}
     */
    getNodeSplatRange(level, x, y, z) {
        const path = [];
        let xp = 0;
        let yp = 0;
        let zp = 0;
        for (let i = level - 1; i >= 0; i--) {
            const p = 1 << (i);

            const xi = Math.floor(x / p);
            const yi = Math.floor(y / p);
            const zi = Math.floor(z / p);

            // relative/recursive index:
            const xr = xi - 2 * xp;
            const yr = yi - 2 * yp;
            const zr = zi - 2 * zp;
            const id = xr + 2 * yr + 4 * zr;
            path.push(id);

            xp = xi;
            yp = yi;
            zp = zi;
        }

        let node = this.splatSubTree.rootNode;
        for (const i of path) {
            const id = this.nodeIndexRemap[i];
            if (id === undefined) {
                console.error("KSplatTreeLoader::getNodeSplatRange: node path id out of bounds", id, "Node:", level, x, y, z);
                return null;
            }
            const child = node.children[this.nodeIndexRemap[i]];
            if (child === undefined) {
                console.error("KSplatTreeLoader::getNodeSplatRange: child id not found", node, level, x, y, z);
                return null;
            }

            node = child;
        }

        const nodeIndexes = node.data.indexes;
        console.log(nodeIndexes.length, "For: ", level, x, y, z);
        if (nodeIndexes.length === 0) {
            return null
        }

        return { from: nodeIndexes[0], to: nodeIndexes[nodeIndexes.length - 1], count: nodeIndexes.length };
    }

    loadNode(level, x, y, z, format) {
        const nodeRange = this.getNodeSplatRange(level, x, y, z);
        if (!nodeRange) {
            return null;
        }

        /////////////////////////////////////////////// TEMPORARY

        //TODO: THIS IS WAY TOO SLOW. Load raw bytes. Decode on worker from a worker pool
        // Load the entire raw range of splats. From: offset + bytesPerSplat * (from), To: offset + bytesPerSplat * (to)
        const packed = SplatDataPacking.packFromSplatBuffer(
            this.splatBuffer,
            nodeRange.from, nodeRange.to,
            format,
            0 //TODO: add minimumAlpha arg
        );

        ///////////////////////////////////////////////

        return packed;
    }

    loadSubtree(level, x, y, z) {
        //TODO: Add support for loading subtrees that are not root !
        const isRootNode = level === 0 && x === 0 && y === 0 && z === 0;
        if (!isRootNode) {
            return null
        }

        return this.splatSubTree;
    }

    static async loadHeader(url) {
        const headerBuffer = await ITiledSplatFileLoader.fetchBytes(
            url,
            0,
            KSplatHeader.HeaderSizeBytes
        );

        if (!headerBuffer) {
            return {};
        }

        KSplatTreeLoader.checkVersion(headerBuffer);
        const headerData = KSplatHeader.parseHeaderData(headerBuffer);
        headerData.sectionCount = headerData.maxSectionCount;
        headerData.splatCount = headerData.maxSplatCount;

        const sectionsBuffer = await ITiledSplatFileLoader.fetchBytes(
            url,
            KSplatHeader.HeaderSizeBytes,
            KSplatHeader.HeaderSizeBytes + headerData.maxSectionCount * KSplatHeader.SectionHeaderSizeBytes
        );
        const sectionHeadersData = KSplatHeader.parseSectionHeaders(headerData, sectionsBuffer, true, 0);
        return new KSplatHeader(headerData, sectionHeadersData);
    }

    /**
     * Loads an entire range of
     */
    static loadSplats() {
        //
    }

    /**
     * @param {SplatBuffer} splatBuffer
     * @return {SplatSubTree}
     */
    // TODO: load from url. Only load the tree portion
    static loadTree(splatBuffer) {
        const offset = KSplatHeader.calculateTotalSplatBufferSize(splatBuffer);
        const subTreeRoot = KSplatTreeBuffer.deserializeOctreeBuffer(
            splatBuffer.bufferData,
            offset,
            StreamingMode.Tiles
        );
        const subtree = new SplatSubTree(this.maxDepth, this.maxCentersPerNode);
        subtree.sceneMin = subTreeRoot.min;
        subtree.sceneMax = subTreeRoot.max;
        subtree.rootNode = subTreeRoot;
        return subtree;
    }

   static checkVersion(buffer) {
        const minVersionMajor = KSplatHeader.CurrentMajorVersion;
        const minVersionMinor = KSplatHeader.CurrentMinorVersion;
        const header = KSplatHeader.parseHeaderData(buffer);
        if (header.versionMajor === minVersionMajor &&
            header.versionMinor >= minVersionMinor ||
            header.versionMajor > minVersionMajor) {
           return true;
        } else {
            throw new Error(`KSplat version not supported: v${header.versionMajor}.${header.versionMinor}. ` +
                            `Minimum required: v${minVersionMajor}.${minVersionMinor}`);
        }
    };

    /**
     * Loads a KSplatTree in immediate mode (the full content is loaded into memory at once inside a SplatBuffer object)
     */
    static loadFromURL(fileName, externalOnProgress, progressiveLoadToSplatBuffer, onSectionBuilt, headers) {
        let directLoadBuffer;
        let directLoadSplatBuffer;

        let headerBuffer;
        let header;
        let headerLoaded = false;
        let headerLoading = false;

        let sectionHeadersBuffer;
        let sectionHeaders = [];
        let sectionHeadersLoaded = false;
        let sectionHeadersLoading = false;

        let numBytesLoaded = 0;
        let numBytesProgressivelyLoaded = 0;
        let totalBytesToDownload = 0;

        let downloadComplete = false;
        let loadComplete = false;
        let loadSectionQueued = false;

        let chunks = [];

        const directLoadPromise = nativePromiseWithExtractedComponents();

        const checkAndLoadHeader = () => {
            if (!headerLoaded && !headerLoading && numBytesLoaded >= KSplatHeader.HeaderSizeBytes) {
                headerLoading = true;
                const headerAssemblyPromise = new Blob(chunks).arrayBuffer();
                headerAssemblyPromise.then((bufferData) => {
                    headerBuffer = new ArrayBuffer(KSplatHeader.HeaderSizeBytes);
                    new Uint8Array(headerBuffer).set(new Uint8Array(bufferData, 0, KSplatHeader.HeaderSizeBytes));
                    KSplatLoader.checkVersion(headerBuffer);
                    headerLoading = false;
                    headerLoaded = true;
                    header = KSplatHeader.parseHeaderData(headerBuffer);
                    window.setTimeout(() => {
                        checkAndLoadSectionHeaders();
                    }, 1);
                });
            }
        };

        let queuedCheckAndLoadSectionsCount = 0;
        const queueCheckAndLoadSections = () => {
            if (queuedCheckAndLoadSectionsCount === 0) {
                queuedCheckAndLoadSectionsCount++;
                window.setTimeout(() => {
                    queuedCheckAndLoadSectionsCount--;
                    checkAndLoadSections();
                }, 1);
            }
        };

        const checkAndLoadSectionHeaders = () => {
            const performLoad = () => {
                sectionHeadersLoading = true;
                const sectionHeadersAssemblyPromise = new Blob(chunks).arrayBuffer();
                sectionHeadersAssemblyPromise.then((bufferData) => {
                    sectionHeadersLoading = false;
                    sectionHeadersLoaded = true;
                    sectionHeadersBuffer = new ArrayBuffer(header.maxSectionCount * KSplatHeader.SectionHeaderSizeBytes);
                    new Uint8Array(sectionHeadersBuffer).set(new Uint8Array(bufferData, KSplatHeader.HeaderSizeBytes,
                                                                            header.maxSectionCount * KSplatHeader.SectionHeaderSizeBytes));
                    sectionHeaders = KSplatHeader.parseSectionHeaders(header, sectionHeadersBuffer, 0, false);
                    let totalSectionStorageStorageByes = 0;
                    for (let i = 0; i < header.maxSectionCount; i++) {
                        totalSectionStorageStorageByes += sectionHeaders[i].storageSizeBytes;
                    }
                    const totalStorageSizeBytes = KSplatHeader.HeaderSizeBytes + header.maxSectionCount *
                                                  KSplatHeader.SectionHeaderSizeBytes + totalSectionStorageStorageByes;
                    if (!directLoadBuffer) {
                        directLoadBuffer = new ArrayBuffer(totalStorageSizeBytes);
                        let offset = 0;
                        for (let i = 0; i < chunks.length; i++) {
                            const chunk = chunks[i];
                            new Uint8Array(directLoadBuffer, offset, chunk.byteLength).set(new Uint8Array(chunk));
                            offset += chunk.byteLength;
                        }
                    }

                    totalBytesToDownload = KSplatHeader.HeaderSizeBytes + KSplatHeader.SectionHeaderSizeBytes * header.maxSectionCount;
                    for (let i = 0; i <= sectionHeaders.length && i < header.maxSectionCount; i++) {
                        totalBytesToDownload += sectionHeaders[i].storageSizeBytes;
                    }

                    queueCheckAndLoadSections();
                });
            };

            if (!sectionHeadersLoading && !sectionHeadersLoaded && headerLoaded &&
                numBytesLoaded >= KSplatHeader.HeaderSizeBytes + KSplatHeader.SectionHeaderSizeBytes * header.maxSectionCount) {
                performLoad();
            }
        };

        const checkAndLoadSections = () => {
            if (loadSectionQueued) return;
            loadSectionQueued = true;
            const checkAndLoadFunc = () => {
                loadSectionQueued = false;
                if (sectionHeadersLoaded) {

                    if (loadComplete) return;

                    downloadComplete = numBytesLoaded >= totalBytesToDownload;

                    let bytesLoadedSinceLastSection = numBytesLoaded - numBytesProgressivelyLoaded;
                    if (bytesLoadedSinceLastSection > Constants.ProgressiveLoadSectionSize || downloadComplete) {

                        numBytesProgressivelyLoaded += Constants.ProgressiveLoadSectionSize;
                        loadComplete = numBytesProgressivelyLoaded >= totalBytesToDownload;

                        if (!directLoadSplatBuffer) directLoadSplatBuffer = new SplatBuffer(directLoadBuffer, false);

                        const baseDataOffset = KSplatHeader.HeaderSizeBytes + KSplatHeader.SectionHeaderSizeBytes * header.maxSectionCount;
                        let sectionBase = 0;
                        let reachedSections = 0;
                        let loadedSplatCount = 0;
                        for (let i = 0; i < header.maxSectionCount; i++) {
                            const sectionHeader = sectionHeaders[i];
                            const bucketsDataOffset = sectionBase + sectionHeader.partiallyFilledBucketCount * 4 +
                                                    sectionHeader.bucketStorageSizeBytes * sectionHeader.bucketCount;
                            const bytesRequiredToReachSectionSplatData = baseDataOffset + bucketsDataOffset;
                            if (numBytesProgressivelyLoaded >= bytesRequiredToReachSectionSplatData) {
                                reachedSections++;
                                const bytesPastSSectionSplatDataStart = numBytesProgressivelyLoaded - bytesRequiredToReachSectionSplatData;
                                const baseDescriptor = KSplatHeader.CompressionLevels[header.compressionLevel];
                                const shDesc = baseDescriptor.SphericalHarmonicsDegrees[sectionHeader.sphericalHarmonicsDegree];
                                const bytesPerSplat = shDesc.BytesPerSplat;
                                let loadedSplatsForSection = Math.floor(bytesPastSSectionSplatDataStart / bytesPerSplat);
                                loadedSplatsForSection = Math.min(loadedSplatsForSection, sectionHeader.maxSplatCount);
                                loadedSplatCount += loadedSplatsForSection;
                                directLoadSplatBuffer.updateLoadedCounts(reachedSections, loadedSplatCount);
                                directLoadSplatBuffer.updateSectionLoadedCounts(i, loadedSplatsForSection);
                            } else {
                                break;
                            }
                            sectionBase += sectionHeader.storageSizeBytes;
                        }

                        onSectionBuilt(directLoadSplatBuffer, loadComplete);

                        const percentComplete = numBytesProgressivelyLoaded / totalBytesToDownload * 100;
                        const percentLabel = (percentComplete).toFixed(2) + '%';

                        if (externalOnProgress) externalOnProgress(percentComplete, percentLabel, LoaderStatus.Downloading);

                        if (loadComplete) {
                            directLoadPromise.resolve(directLoadSplatBuffer);
                        } else {
                            checkAndLoadSections();
                        }
                    }
                }
            };
            window.setTimeout(checkAndLoadFunc, Constants.ProgressiveLoadSectionDelayDuration);
        };

        const localOnProgress = (percent, percentStr, chunk) => {
            if (chunk) {
                chunks.push(chunk);
                if (directLoadBuffer) {
                    new Uint8Array(directLoadBuffer, numBytesLoaded, chunk.byteLength).set(new Uint8Array(chunk));
                }
                numBytesLoaded += chunk.byteLength;
            }
            if (progressiveLoadToSplatBuffer) {
                checkAndLoadHeader();
                checkAndLoadSectionHeaders();
                checkAndLoadSections();
            } else {
                if (externalOnProgress) externalOnProgress(percent, percentStr, LoaderStatus.Downloading);
            }
        };

        return fetchWithProgress(fileName, localOnProgress, !progressiveLoadToSplatBuffer, headers).then((fullBuffer) => {
            if (externalOnProgress) externalOnProgress(0, '0%', LoaderStatus.Processing);
            const loadPromise = progressiveLoadToSplatBuffer ? directLoadPromise.promise : KSplatTreeLoader.loadFromFileData(fullBuffer);
            return loadPromise.then((splatBuffer) => {
                if (externalOnProgress) externalOnProgress(100, '100%', LoaderStatus.Done);
                splatBuffer.isKSTree = true;
                return splatBuffer;
            });
        });
    }

    static loadFromFileData(fileData) {
        return delayedExecute(() => {
            KSplatTreeLoader.checkVersion(fileData);
            return new SplatBuffer(fileData);
        });
    }
}
