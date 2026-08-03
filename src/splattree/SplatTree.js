/* eslint-disable */
import * as THREE from 'three';
import { delayedExecute } from '../Util.js';


class SplatTreeNode {

    static idGen = 0;

    constructor(min, max, depth, id) {
        this.min = new THREE.Vector3().copy(min);
        this.max = new THREE.Vector3().copy(max);
        this.boundingBox = new THREE.Box3(this.min, this.max);
        this.center = new THREE.Vector3().copy(this.max).sub(this.min).multiplyScalar(0.5).add(this.min);
        this.depth = depth;
        this.children = [];
        this.data = null;
        this.id = id || SplatTreeNode.idGen++;
        this.sampled = false;
    }

    getNumPoints() {
        if (!this.data || !this.data.indexes) {
            return 0;
        }

        return this.data.indexes.length;
    }
}

class SplatSubTree {

    constructor(maxDepth, maxCentersPerNode) {
        this.maxDepth = maxDepth;
        this.maxCentersPerNode = maxCentersPerNode;
        this.sceneDimensions = new THREE.Vector3();
        this.sceneMin = new THREE.Vector3();
        this.sceneMax = new THREE.Vector3();
        this.rootNode = null;
        this.nodesWithIndexes = [];
        this.splatMesh = null;
    }

    static convertWorkerSubTreeNode(workerSubTreeNode) {
        const minVector = new THREE.Vector3().fromArray(workerSubTreeNode.min);
        const maxVector = new THREE.Vector3().fromArray(workerSubTreeNode.max);
        const convertedNode = new SplatTreeNode(minVector, maxVector, workerSubTreeNode.depth, workerSubTreeNode.id);
        if (workerSubTreeNode.data.indexes) {
            convertedNode.data = {
                'indexes': []
            };
            for (let index of workerSubTreeNode.data.indexes) {
                convertedNode.data.indexes.push(index);
            }
        }
        if (workerSubTreeNode.children) {
            for (let child of workerSubTreeNode.children) {
                convertedNode.children.push(SplatSubTree.convertWorkerSubTreeNode(child));
            }
        }
        return convertedNode;
    }

    static convertWorkerSubTree(workerSubTree, splatMesh) {
        const convertedSubTree = new SplatSubTree(workerSubTree.maxDepth, workerSubTree.maxCentersPerNode);
        convertedSubTree.sceneMin = new THREE.Vector3().fromArray(workerSubTree.sceneMin);
        convertedSubTree.sceneMax = new THREE.Vector3().fromArray(workerSubTree.sceneMax);

        convertedSubTree.splatMesh = splatMesh;
        convertedSubTree.rootNode = SplatSubTree.convertWorkerSubTreeNode(workerSubTree.rootNode);


        const visitLeavesFromNode = (node, visitFunc) => {
            if (node.children.length === 0) visitFunc(node);
            for (let child of node.children) {
                visitLeavesFromNode(child, visitFunc);
            }
        };

        /**
         * TODO: Refactor. Do the traversal at rendering/sorting time
         */

        convertedSubTree.nodesWithIndexes = [];
        visitLeavesFromNode(convertedSubTree.rootNode, (node) => {
            if (node.data && node.data.indexes && node.data.indexes.length > 0) {
                convertedSubTree.nodesWithIndexes.push(node);
            }
        });

        return convertedSubTree;
    }
}

function createSplatTreeWorker(self) {

    let WorkerSplatTreeNodeIDGen = 0;

    class WorkerBox3 {

        constructor(min, max) {
            this.min = [min[0], min[1], min[2]];
            this.max = [max[0], max[1], max[2]];
        }

        containsPoint(point) {
            return point[0] >= this.min[0] && point[0] <= this.max[0] &&
                   point[1] >= this.min[1] && point[1] <= this.max[1] &&
                   point[2] >= this.min[2] && point[2] <= this.max[2];
        }
    }

    class WorkerSplatSubTree {

        constructor(maxDepth, maxCentersPerNode) {
            this.maxDepth = maxDepth;
            this.maxCentersPerNode = maxCentersPerNode;
            this.sceneDimensions = [];
            this.sceneMin = [];
            this.sceneMax = [];
            this.rootNode = null;
            this.addedIndexes = {};
            this.nodesWithIndexes = [];
            this.splatMesh = null;
            this.disposed = false;
        }

    }

    class WorkerSplatTreeNode {

        constructor(min, max, depth, id) {
            this.min = [min[0], min[1], min[2]];
            this.max = [max[0], max[1], max[2]];
            this.center = [(max[0] - min[0]) * 0.5 + min[0],
                           (max[1] - min[1]) * 0.5 + min[1],
                           (max[2] - min[2]) * 0.5 + min[2]];
            this.depth = depth;
            this.children = [];
            this.data = null;
            this.id = id || WorkerSplatTreeNodeIDGen++;
        }

    }

    processSplatTreeNode = function(tree, node, indexToCenter, sceneCenters) {
        const splatCount = node.data.indexes.length;

        if (splatCount < tree.maxCentersPerNode || node.depth > tree.maxDepth) {
            const newIndexes = [];
            for (let i = 0; i < node.data.indexes.length; i++) {
                if (!tree.addedIndexes[node.data.indexes[i]]) {
                    newIndexes.push(node.data.indexes[i]);
                    tree.addedIndexes[node.data.indexes[i]] = true;
                }
            }
            node.data.indexes = newIndexes;
            node.data.indexes.sort((a, b) => {
                if (a > b) return 1;
                else return -1;
            });
            tree.nodesWithIndexes.push(node);
            return;
        }

        const nodeDimensions = [node.max[0] - node.min[0],
                                node.max[1] - node.min[1],
                                node.max[2] - node.min[2]];
        const halfDimensions = [nodeDimensions[0] * 0.5,
                                nodeDimensions[1] * 0.5,
                                nodeDimensions[2] * 0.5];
        const nodeCenter = [node.min[0] + halfDimensions[0],
                            node.min[1] + halfDimensions[1],
                            node.min[2] + halfDimensions[2]];

        const childrenBounds = [
            // top section, clockwise from upper-left (looking from above, +Y)
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1], nodeCenter[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2] + halfDimensions[2]]),
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1], nodeCenter[2]],
                           [nodeCenter[0], nodeCenter[1] + halfDimensions[1], nodeCenter[2] + halfDimensions[2]]),

            // bottom section, clockwise from lower-left (looking from above, +Y)
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0], nodeCenter[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2] - halfDimensions[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1], nodeCenter[2]]),
            new WorkerBox3([nodeCenter[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2]],
                           [nodeCenter[0] + halfDimensions[0], nodeCenter[1], nodeCenter[2] + halfDimensions[2]]),
            new WorkerBox3([nodeCenter[0] - halfDimensions[0], nodeCenter[1] - halfDimensions[1], nodeCenter[2]],
                           [nodeCenter[0], nodeCenter[1], nodeCenter[2] + halfDimensions[2]]),
        ];

        /**
         * TODO: Use potree strategy for building the hierarchy
         */

        const splatCounts = [];
        const baseIndexes = [];
        for (let i = 0; i < childrenBounds.length; i++) {
            splatCounts[i] = 0;
            baseIndexes[i] = [];
        }

        const center = [0, 0, 0];
        for (let i = 0; i < splatCount; i++) {
            const splatGlobalIndex = node.data.indexes[i];
            const centerBase = indexToCenter[splatGlobalIndex];
            center[0] = sceneCenters[centerBase];
            center[1] = sceneCenters[centerBase + 1];
            center[2] = sceneCenters[centerBase + 2];
            for (let j = 0; j < childrenBounds.length; j++) {
                if (childrenBounds[j].containsPoint(center)) {
                    splatCounts[j]++;
                    baseIndexes[j].push(splatGlobalIndex);
                }
            }
        }

        for (let i = 0; i < childrenBounds.length; i++) {
            const childNode = new WorkerSplatTreeNode(childrenBounds[i].min, childrenBounds[i].max, node.depth + 1);
            childNode.data = {
                'indexes': baseIndexes[i]
            };
            node.children.push(childNode);
        }

        node.data = {};
        for (let child of node.children) {
            processSplatTreeNode(tree, child, indexToCenter, sceneCenters);
        }
        return;
    };

    class Point {
        constructor(x, y, z, pointId, childId) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.pointId = pointId;
            this.childId = childId;
        }
    }

    function poissonSample(treeNode, sceneCenters, indexToCenter, baseSpacing) {

        const traversePost = (node, callback, nodeName = "r") => {
            node.name = nodeName;
            const childCount = node.children.length ?? 0;
            for (let i = 0; i < childCount; i++) {
                const child = node.children[i];
                if (child !== null && !child.sampled) {
                    traversePost(child, callback, nodeName + i);
                }
            }
            callback(node);
        };

        const sampleNode = (node) => {
            const isLeaf = node.children.length === 0;
            if (isLeaf) {
                return false;
            }


            const points = [];
            node.sampled = true;

            const acceptedChildPointFlags = [];
            let numRejectedPerChild = [0, 0, 0, 0, 0, 0, 0, 0];
            let numAccepted = 0;

            // Sample from children
            for (let childIndex = 0; childIndex < 8; childIndex++) {
                const child = node.children[childIndex];

                if (!child) {
                    acceptedChildPointFlags.push([]);
                    numRejectedPerChild[childIndex] = 0;

                    continue;
                }

                if (!child.data) {
                    continue;
                }

                const numPoints = child.data.indexes.length;
                const acceptedFlags = new Int8Array(numPoints);
                acceptedChildPointFlags.push(acceptedFlags);

                for (let i = 0; i < numPoints; i++) {
                    const splatGlobalIndex = child.data.indexes[i];
                    const centerBase = indexToCenter[splatGlobalIndex];
                    const x = sceneCenters[centerBase];
                    const y = sceneCenters[centerBase + 1];
                    const z = sceneCenters[centerBase + 2];

                    points.push(new Point(x, y, z, i, childIndex));
                }
            }

            const squaredDistance = (a, b) => {
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const dz = a.z - b.z;

                return dx * dx + dy * dy + dz * dz;
            };

            let dbgNumAccepted = 0;
            const dbgAccepted = [];
            const spacing = baseSpacing / Math.pow(2.0, node.depth);
            const squaredSpacing = spacing * spacing;
            const center = {
                x: node.center[0],
                y: node.center[1],
                z: node.center[2],
            };

            const checkAccept = (candidate) => {
                const cx = candidate.x - center.x;
                const cy = candidate.y - center.y;
                const cz = candidate.z - center.z;
                const cdd = cx * cx + cy * cy + cz * cz;
                const cd = Math.sqrt(cdd);
                const limit = (cd - spacing);
                const limitSquared = limit * limit;

                let j = 0;

                for (let i = dbgNumAccepted - 1; i >= 0; i--) {

                    const point = dbgAccepted[i];

                    // check distance to center
                    const px = point.x - center.x;
                    const py = point.y - center.y;
                    const pz = point.z - center.z;
                    const pdd = px * px + py * py + pz * pz;

                    // stop when differences to center between candidate and accepted exceeds the spacing
                    // any other previously accepted point will be even closer to the center.
                    if (pdd < limitSquared) {
                        return true;
                    }

                    const dd = squaredDistance(point, candidate);

                    if (dd < squaredSpacing) {
                        return false;
                    }

                    j++;

                    // also put a limit at x distance checks
                    if (j > 10000) {
                        return true;
                    }
                }

                return true;
            };

            points.sort((a, b) => {
                const ax = a.x - center.x;
                const ay = a.y - center.y;
                const az = a.z - center.z;
                const add = ax * ax + ay * ay + az * az;

                const bx = b.x - center.x;
                const by = b.y - center.y;
                const bz = b.z - center.z;
                const bdd = bx * bx + by * by + bz * bz;

                return add - bdd;
            });

            for (const point of points) {
                const isAccepted = checkAccept(point);

                if (isAccepted) {
                    dbgAccepted[dbgNumAccepted] = point;
                    dbgNumAccepted++;
                    numAccepted++;
                } else {
                    numRejectedPerChild[point.childId]++;
                }

                acceptedChildPointFlags[point.childId][point.pointId] = isAccepted ? 1 : 0;
            }
            // console.log(acceptedChildPointFlags);
            // console.log(numRejectedPerChild)
            // console.log("NUM ACCEPTED: ", numAccepted);
            const accepted = [];
            let emptyChildren = 0;
            for (let childIndex = 0; childIndex < 8; childIndex++) {
                const child = node.children[childIndex];

                if (!child) {
                    continue;
                }

                const numRejected = numRejectedPerChild[childIndex];
                const acceptedFlags = acceptedChildPointFlags[childIndex];
                const rejected = []
                const numPoints = child.data.indexes.length;

                for (let i = 0; i < numPoints; i++) {
                    const isAccepted = acceptedFlags[i] > 0;
                    const splatGlobalIndex = child.data.indexes[i];

                    if (isAccepted) {
                        accepted.push(splatGlobalIndex);
                    } else {
                        rejected.push(splatGlobalIndex);
                    }
                }

                if (numRejected === 0 && child.children.length === 0) {
                    //node.children[childIndex] = null;
                    // console.log("LEAF CHILD LEFT WITH 0 POINTS")
                    child.data = null;
                    emptyChildren++;
                } if (numRejected > 0) {
                    child.data = {
                        'indexes': rejected
                    };
                } else if(numRejected === 0) {
                    // console.log("INTERNAL CHILD HAS 0 POINTS")
                    // the parent has taken all points from this child,
                    // so make this child an empty inner node.
                    // Otherwise, the hierarchy file will claim that
                    // this node has points but because it doesn't have any,
                    // decompressing the nonexistent point buffer fails
                    // https://github.com/potree/potree/issues/1125
                    child.data = {
                        'indexes': []
                    };
                    emptyChildren++;
                }
            }

            if (emptyChildren === 8) {
                let numGrandChildren = 0;
                for (const child of node.children) {
                    numGrandChildren += child.children.length ?? 0;
                }

                if (numGrandChildren === 0) {
                    console.warn("PARENT took all data from ALL children", node.name)
                    node.children = [];
                }
            }

            node.data = {
                'indexes': accepted
            };

            return true;
        }

        traversePost(treeNode, sampleNode);
    }

    const buildSubTree = (sceneCenters, maxDepth, maxCentersPerNode) => {

        const sceneMin = [0, 0, 0];
        const sceneMax = [0, 0, 0];
        const indexes = [];
        const centerCount = Math.floor(sceneCenters.length / 4);
        for ( let i = 0; i < centerCount; i ++) {
            const base = i * 4;
            const x = sceneCenters[base];
            const y = sceneCenters[base + 1];
            const z = sceneCenters[base + 2];
            const index = Math.round(sceneCenters[base + 3]);
            if (i === 0 || x < sceneMin[0]) sceneMin[0] = x;
            if (i === 0 || x > sceneMax[0]) sceneMax[0] = x;
            if (i === 0 || y < sceneMin[1]) sceneMin[1] = y;
            if (i === 0 || y > sceneMax[1]) sceneMax[1] = y;
            if (i === 0 || z < sceneMin[2]) sceneMin[2] = z;
            if (i === 0 || z > sceneMax[2]) sceneMax[2] = z;
            indexes.push(index);
        }
        const subTree = new WorkerSplatSubTree(maxDepth, maxCentersPerNode);
        subTree.sceneMin = sceneMin;
        subTree.sceneMax = sceneMax;
        subTree.rootNode = new WorkerSplatTreeNode(subTree.sceneMin, subTree.sceneMax, 0);
        subTree.rootNode.data = {
            'indexes': indexes
        };

        return subTree;
    };

    function createSplatTree(allCenters, maxDepth, maxCentersPerNode) {
        const indexToCenter = [];
        for (let sceneCenters of allCenters) {
            const centerCount = Math.floor(sceneCenters.length / 4);
            for ( let i = 0; i < centerCount; i ++) {
                const base = i * 4;
                const index = Math.round(sceneCenters[base + 3]);
                indexToCenter[index] = base;
            }
        }
        const subTrees = [];
        for (let sceneCenters of allCenters) {
            const subTree = buildSubTree(sceneCenters, maxDepth, maxCentersPerNode);
            subTrees.push(subTree);
            processSplatTreeNode(subTree, subTree.rootNode, indexToCenter, sceneCenters);

            const baseSpacing = (subTree.rootNode.max[0] - subTree.rootNode.min[0]) / 128.0;
            poissonSample(subTree.rootNode, sceneCenters, indexToCenter, baseSpacing);
        }
        self.postMessage({
            'subTrees': subTrees
        });
    }

    self.onmessage = (e) => {
        if (e.data.process) {
            createSplatTree(e.data.process.centers, e.data.process.maxDepth, e.data.process.maxCentersPerNode);
        }
    };
}

function workerProcessCenters(splatTreeWorker, centers, transferBuffers, maxDepth, maxCentersPerNode) {
    splatTreeWorker.postMessage({
        'process': {
            'centers': centers,
            'maxDepth': maxDepth,
            'maxCentersPerNode': maxCentersPerNode
        }
    }, transferBuffers);
}

function checkAndCreateWorker() {
    const splatTreeWorker = new Worker(
        URL.createObjectURL(
            new Blob(['(', createSplatTreeWorker.toString(), ')(self)'], {
                type: 'application/javascript',
            }),
        ),
    );
    return splatTreeWorker;
}

/**
 * SplatTree: Octree tailored to splat data from a SplatMesh instance
 */
export class SplatTree {

    constructor(maxDepth, maxCentersPerNode) {
        this.maxDepth = maxDepth;
        this.maxCentersPerNode = maxCentersPerNode;
        this.subTrees = [];
        this.splatMesh = null;
    }


    dispose() {
        this.diposeSplatTreeWorker();
        this.disposed = true;
    }

    diposeSplatTreeWorker() {
        if (this.splatTreeWorker) this.splatTreeWorker.terminate();
        this.splatTreeWorker = null;
    };

    /**
     * Construct this instance of SplatTree from an instance of SplatMesh.
     *
     * @param {SplatMesh} splatMesh The instance of SplatMesh from which to construct this splat tree.
     * @param {function} filterFunc Optional function to filter out unwanted splats.
     * @param {function} onIndexesUpload Function to be called when the upload of splat centers to the splat tree
     *                                   builder worker starts and finishes.
     * @param {function} onSplatTreeConstruction Function to be called when the conversion of the local splat tree from
     *                                           the format produced by the splat tree builder worker starts and ends.
     * @return {undefined}
     */
    processSplatMesh = function(splatMesh, filterFunc = () => true, onIndexesUpload, onSplatTreeConstruction) {
        if (!this.splatTreeWorker) this.splatTreeWorker = checkAndCreateWorker();

        this.splatMesh = splatMesh;
        this.subTrees = [];
        const center = new THREE.Vector3();

        const addCentersForScene = (splatOffset, splatCount) => {
            const sceneCenters = new Float32Array(splatCount * 4);
            let addedCount = 0;
            for (let i = 0; i < splatCount; i++) {
                const globalSplatIndex = i + splatOffset;
                if (filterFunc(globalSplatIndex)) {
                    splatMesh.getSplatCenter(globalSplatIndex, center);
                    const addBase = addedCount * 4;
                    sceneCenters[addBase] = center.x;
                    sceneCenters[addBase + 1] = center.y;
                    sceneCenters[addBase + 2] = center.z;
                    sceneCenters[addBase + 3] = globalSplatIndex;
                    addedCount++;
                }
            }
            return sceneCenters;
        };

        return new Promise((resolve) => {

            const checkForEarlyExit = () => {
                if (this.disposed) {
                    this.diposeSplatTreeWorker();
                    resolve();
                    return true;
                }
                return false;
            };

            if (onIndexesUpload) onIndexesUpload(false);

            delayedExecute(() => {

                if (checkForEarlyExit()) return;

                const allCenters = [];
                if (splatMesh.dynamicMode) {
                    let splatOffset = 0;
                    for (let s = 0; s < splatMesh.scenes.length; s++) {
                        const scene = splatMesh.getScene(s);
                        const splatCount = scene.splatBuffer.getSplatCount();
                        const sceneCenters = addCentersForScene(splatOffset, splatCount);
                        allCenters.push(sceneCenters);
                        splatOffset += splatCount;
                    }
                } else {
                    const sceneCenters = addCentersForScene(0, splatMesh.getSplatCount());
                    allCenters.push(sceneCenters);
                }

                this.splatTreeWorker.onmessage = (e) => {

                    if (checkForEarlyExit()) return;

                    if (e.data.subTrees) {

                        if (onSplatTreeConstruction) onSplatTreeConstruction(false);

                        delayedExecute(() => {

                            if (checkForEarlyExit()) return;

                            for (let workerSubTree of e.data.subTrees) {
                                const convertedSubTree = SplatSubTree.convertWorkerSubTree(workerSubTree, splatMesh);
                                this.subTrees.push(convertedSubTree);
                            }
                            this.diposeSplatTreeWorker();

                            if (onSplatTreeConstruction) onSplatTreeConstruction(true);

                            delayedExecute(() => {
                                resolve();
                            });

                        });
                    }
                };

                delayedExecute(() => {
                    if (checkForEarlyExit()) return;
                    if (onIndexesUpload) onIndexesUpload(true);
                    const transferBuffers = allCenters.map((array) => array.buffer);
                    workerProcessCenters(this.splatTreeWorker, allCenters, transferBuffers, this.maxDepth, this.maxCentersPerNode);
                });

            });

        });

    };

    countLeaves() {

        let leafCount = 0;
        this.visitLeaves(() => {
            leafCount++;
        });

        return leafCount;
    }

    visitLeaves(visitFunc) {

        const visitLeavesFromNode = (node, visitFunc) => {
            if (node.children.length === 0) visitFunc(node);
            for (let child of node.children) {
                visitLeavesFromNode(child, visitFunc);
            }
        };

        for (let subTree of this.subTrees) {
            visitLeavesFromNode(subTree.rootNode, visitFunc);
        }
    }

}
