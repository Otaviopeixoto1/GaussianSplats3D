import { SplatBuffer } from '../SplatBuffer.js';
import { fetchWithProgress, delayedExecute, nativePromiseWithExtractedComponents } from '../../Util.js';
import { LoaderStatus } from '../LoaderStatus.js';
import { Constants } from '../../Constants.js';
import * as THREE from "three";
import {SplatTreeNode} from "../../splattree/SplatTree.js";

// TODO: add a potree-like tree build system that can also be loaded with this
//

export class KSplatTreeBuffer {
    constructor(splatBuffer, subTree) {
        const ksplatBuffer = splatBuffer.bufferData;
        const treeBuffer = KSplatTreeBuffer.serializeOctreeToBuffer(subTree);

        const totalByteLength = ksplatBuffer.byteLength + treeBuffer.byteLength;

        this.bufferData = new ArrayBuffer(totalByteLength);
        const finalView = new Uint8Array(this.bufferData);

        const view1 = new Uint8Array(ksplatBuffer);
        const view2 = new Uint8Array(treeBuffer);

        // Copy the splats to the start of the buffer and the tree to the end
        finalView.set(view1, 0);
        finalView.set(view2, ksplatBuffer.byteLength);
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

        // 1 Int (total node count) + 6 Floats (BBox) + (10 Ints for each node)
        const headerElementCount = 1 + 6 + (nodeCount * 10);
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

            for (let i = 0; i < 8; i++) {
                const childNode = node.children[i];
                const childId = childNode ? nodeToIdMap.get(childNode) : -1;
                view.setInt32(byteOffset, childId, true); byteOffset += 4;
            }

            if (jsArray.length > 0) {
                const elementOffset = currentDataByteOffset / bytesPerInt;
                rawDataView.set(new Int32Array(jsArray), elementOffset);
            }

            currentDataByteOffset += jsArray.length * bytesPerInt;
        }

        return fileBuffer;
    }


    static deserializeOctreeBuffer(fileBuffer, offset) {
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

        const nodeDataList = [];
        const nodeIdToChildrenIds = [];

        for (let i = 0; i < nodeCount; i++) {
            const dataByteOffset = offset + view.getInt32(byteOffset, true);
            byteOffset += 4;
            const elementLength = view.getInt32(byteOffset, true);
            byteOffset += 4;

            const childIds = [];
            for (let c = 0; c < 8; c++) {
                childIds.push(view.getInt32(byteOffset, true));
                byteOffset += 4;
            }

            const nodeData = Array.from(new Int32Array(fileBuffer, dataByteOffset, elementLength));
            nodeDataList.push(nodeData);

            nodeIdToChildrenIds.push(childIds);
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
                const childNode = new SplatTreeNode(childrenBounds[i].min, childrenBounds[i].max, node.depth + 1, childId);
                childNode.data = {
                    'indexes': nodeDataList[childId]
                };
                childNode.sampled = true;
                node.children.push(childNode);
            }
        };

        const treeRootData = nodeDataList[0];
        const treeRoot = new SplatTreeNode(treeMin, treeMax, 0, 0);
        treeRoot.data = {
            'indexes': treeRootData
        };
        treeRoot.sampled = true;

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

export class KSplatTreeLoader {

   static checkVersion(buffer) {
        const minVersionMajor = SplatBuffer.CurrentMajorVersion;
        const minVersionMinor = SplatBuffer.CurrentMinorVersion;
        const header = SplatBuffer.parseHeader(buffer);
        if (header.versionMajor === minVersionMajor &&
            header.versionMinor >= minVersionMinor ||
            header.versionMajor > minVersionMajor) {
           return true;
        } else {
            throw new Error(`KSplat version not supported: v${header.versionMajor}.${header.versionMinor}. ` +
                            `Minimum required: v${minVersionMajor}.${minVersionMinor}`);
        }
    };

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
            if (!headerLoaded && !headerLoading && numBytesLoaded >= SplatBuffer.HeaderSizeBytes) {
                headerLoading = true;
                const headerAssemblyPromise = new Blob(chunks).arrayBuffer();
                headerAssemblyPromise.then((bufferData) => {
                    headerBuffer = new ArrayBuffer(SplatBuffer.HeaderSizeBytes);
                    new Uint8Array(headerBuffer).set(new Uint8Array(bufferData, 0, SplatBuffer.HeaderSizeBytes));
                    KSplatLoader.checkVersion(headerBuffer);
                    headerLoading = false;
                    headerLoaded = true;
                    header = SplatBuffer.parseHeader(headerBuffer);
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
                    sectionHeadersBuffer = new ArrayBuffer(header.maxSectionCount * SplatBuffer.SectionHeaderSizeBytes);
                    new Uint8Array(sectionHeadersBuffer).set(new Uint8Array(bufferData, SplatBuffer.HeaderSizeBytes,
                                                                            header.maxSectionCount * SplatBuffer.SectionHeaderSizeBytes));
                    sectionHeaders = SplatBuffer.parseSectionHeaders(header, sectionHeadersBuffer, 0, false);
                    let totalSectionStorageStorageByes = 0;
                    for (let i = 0; i < header.maxSectionCount; i++) {
                        totalSectionStorageStorageByes += sectionHeaders[i].storageSizeBytes;
                    }
                    const totalStorageSizeBytes = SplatBuffer.HeaderSizeBytes + header.maxSectionCount *
                                                  SplatBuffer.SectionHeaderSizeBytes + totalSectionStorageStorageByes;
                    if (!directLoadBuffer) {
                        directLoadBuffer = new ArrayBuffer(totalStorageSizeBytes);
                        let offset = 0;
                        for (let i = 0; i < chunks.length; i++) {
                            const chunk = chunks[i];
                            new Uint8Array(directLoadBuffer, offset, chunk.byteLength).set(new Uint8Array(chunk));
                            offset += chunk.byteLength;
                        }
                    }

                    totalBytesToDownload = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * header.maxSectionCount;
                    for (let i = 0; i <= sectionHeaders.length && i < header.maxSectionCount; i++) {
                        totalBytesToDownload += sectionHeaders[i].storageSizeBytes;
                    }

                    queueCheckAndLoadSections();
                });
            };

            if (!sectionHeadersLoading && !sectionHeadersLoaded && headerLoaded &&
                numBytesLoaded >= SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * header.maxSectionCount) {
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

                        const baseDataOffset = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes * header.maxSectionCount;
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
                                const baseDescriptor = SplatBuffer.CompressionLevels[header.compressionLevel];
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
            const loadPromise = progressiveLoadToSplatBuffer ? directLoadPromise.promise : KSplatLoader.loadFromFileData(fullBuffer);
            return loadPromise.then((splatBuffer) => {
                if (externalOnProgress) externalOnProgress(100, '100%', LoaderStatus.Done);
                return splatBuffer;
            });
        });
    }

    static loadFromFileData(fileData) {
        return delayedExecute(() => {
            KSplatLoader.checkVersion(fileData);
            return new SplatBuffer(fileData);
        });
    }

    static downloadFile = function() {

        let downLoadLink;

        //TODO: Use the Splatbuffer AND THE TREE. Store them in a buffer, then export
        return function(splatBuffer, fileName) {
            const blob = new Blob([splatBuffer.bufferData], {
                type: 'application/octet-stream',
            });

            if (!downLoadLink) {
                downLoadLink = document.createElement('a');
                document.body.appendChild(downLoadLink);
            }
            downLoadLink.download = fileName;
            downLoadLink.href = URL.createObjectURL(blob);
            downLoadLink.click();
        };

    }();

}
