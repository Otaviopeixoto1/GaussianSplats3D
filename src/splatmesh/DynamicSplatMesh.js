import * as THREE from "three";
import {Constants} from "../Constants.js";
import {LogLevel} from "../LogLevel.js";
import {SplatRenderMode} from "../SplatRenderMode.js";
import {SplatGeometry} from "./SplatGeometry.js";
import {SplatMaterial3D} from "./SplatMaterial3D.js";
import {SplatMaterial2D} from "./SplatMaterial2D.js";
import {SplatScene} from "./SplatScene.js";
import {SplatSubTree, SplatTree, SplatTreeNode} from "../splattree/SplatTree.js";
import {VirtualSplatBuffer} from "../loaders/SplatBuffer.js";
import {GPUSplatAllocator} from '../LOD/GPUSplatAllocator.js'
import {clamp} from "../Util.js";



/**
 * TODO: Manage Nodes and subtrees. Currently we just load the root nodes
 */
export class DynamicSplatMesh extends THREE.Mesh {

    //TODO: Compact this into some kind of EngineSettings interface...
    constructor(halfPrecisionCovariancesOnGPU = false, devicePixelRatio = 1, enableDistancesComputationOnGPU = true,
        integerBasedDistancesComputation = false, antialiased = false, maxScreenSpaceSplatSize = 1024, logLevel = LogLevel.None,
        sphericalHarmonicsDegree = 0, sceneFadeInRateMultiplier = 1.0, kernel2DSize = 0.3) {
        super(Constants.dummyGeometry, Constants.dummyMaterial);

        // Reference to a Three.js renderer
        this.renderer = undefined;

        // Determine how the splats are rendered
        this.splatRenderMode = SplatRenderMode.ThreeD;

        // When 'dynamicMode' is true, scenes are assumed to be non-static. Dynamic scenes are handled differently
        // and certain optimizations cannot be made for them. Additionally, by default, all splat data retrieved from
        // this splat mesh will not have their scene transform applied to them if the splat mesh is dynamic. That
        // can be overriden via parameters to the individual functions that are used to retrieve splat data.
        this.dynamicMode = true;

        // When true, allows for usage of extra properties and attributes during rendering for effects such as opacity adjustment.
        // Default is false for performance reasons. These properties are separate from transform properties (scale, rotation, position)
        // that are enabled by the 'dynamicScene' parameter.
        this.enableOptionalEffects = false;

        this.halfPrecisionCovariancesOnGPU = halfPrecisionCovariancesOnGPU;

        //TODO: Fix the compression level to the maximum compression level of all splat buffers that are used
        this.splatAllocator = new GPUSplatAllocator(this.splatRenderMode, halfPrecisionCovariancesOnGPU, 0, logLevel);

        // Ratio of the resolution in physical pixels to the resolution in CSS pixels for the current display device
        this.devicePixelRatio = devicePixelRatio;

        // Use a transform feedback to calculate splat distances from the camera
        // TODO: Not supported yet by DynamicSplatMesh (the Viewer disables 'gpuAcceleratedSort' when it uses this mesh)
        this.enableDistancesComputationOnGPU = enableDistancesComputationOnGPU;

        // Use a faster integer-based approach for calculating splat distances from the camera.
        // Must match the sort worker setup ('integerBasedSort' in the Viewer), it decides the format of the centers sent to it.
        this.integerBasedDistancesComputation = integerBasedDistancesComputation;

        // See SplatMesh
        this.antialiased = antialiased;
        this.kernel2DSize = kernel2DSize;
        this.maxScreenSpaceSplatSize = maxScreenSpaceSplatSize;

        // The verbosity of console logging
        this.logLevel = logLevel;

        // Degree 0 means no spherical harmonics
        this.sphericalHarmonicsDegree = sphericalHarmonicsDegree;
        this.minSphericalHarmonicsDegree = 0;

        this.sceneFadeInRateMultiplier = sceneFadeInRateMultiplier;

        // The individual splat scenes stored in this splat mesh, each containing their own transform
        this.scenes = [];
        this.sceneOptions = [];

        // Special octree tailored to SplatMesh instances
        //TODO: store octree on the scene itself...
        this.baseSplatTree = null;
        this.splatTree = null;

        // Resident nodes: "sceneIndex:level/x/y/z" -> { sceneIndex, level, x, y, z, node, stagingBuffer, splatOffset, splatCount }
        this.residentNodes = new Map();

        // Command buffer of the sort worker. Every time a node is loaded, its centers and scene indexes are pushed here,
        // stored at the node's global splat indexes, so the sort worker knows about the splat positions.
        this.presortCommandBuffer = null;

        this.renderSplatCount = 0;
        this.firstRenderTime = -1;

        this.splatScale = 1.0;
        this.pointCloudModeEnabled = false;

        // The reveal fade-in of SplatMesh is not used, but the Viewer reads this to decide whether to keep rendering
        this.visibleRegionChanging = false;

        // GPU work is deferred until the mesh is drawn for the first time (see onBeforeRender()). That way the mesh does not
        // need a renderer before it is rendered, which is the case for the DropInViewer.
        // Nodes waiting to be uploaded: { sceneIndex, level, x, y, z }
        this.pendingNodeLoads = [];
        // True once GPUSplatAllocator.setup() has run with the renderer given to onBeforeRender()
        this.splatAllocatorReady = false;
        // Size of the data passed to GPUSplatAllocator.setup()
        this.maxSplatCount = 0;
        // Called after pending nodes were uploaded, see onNodesLoaded()
        this.onNodesLoadedCallback = null;
        // Called after pending nodes were uploaded, see onNodesLoaded()
        this.onSplatTreeReadyCallback = null;

        this.disposed = false;
        this.visible = false;
        this.frustumCulled = false;
    }

    /**
     *
     * Initialization
     *
     */

    /**
     * Optional, the renderer passed to onBeforeRender() is the one used for all GPU work.
     */
    setRenderer(renderer) {
        this.renderer = renderer;
    }

    /**
     * @param {function(DynamicSplatMesh)} callback Called after pending nodes were uploaded to the GPU and their splat centers were pushed to the presort command buffer.
     */
    onNodesLoaded(callback) {
        this.onNodesLoadedCallback = callback;
    }

    /**
     * @param {function(DynamicSplatMesh)} callback Called after the SplatTree is built
     */
    onSplatTreeReady(callback) {
        this.onSplatTreeReadyCallback = callback;
    }

    /**
     * @param {Array<VirtualSplatBuffer>} virtualSplatBuffers The base splat data
     * @param {Array<object>} sceneOptions Dynamic options for each scene {
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *         scale (Array<number>):      Scene scale, defaults to [1, 1, 1]
     * }
     * @param {WorkerCommandBuffer} presortCommandBuffer The command buffer used for presort commands (sort worker splat data uploads)
     * @param {number=} maxRenderSplatCount Size of the splat index buffer. Defaults to the total splat count of the virtual splat buffers.
     */
    build(virtualSplatBuffers, sceneOptions = [], presortCommandBuffer, maxRenderSplatCount) {
        if (this.logLevel >= LogLevel.Info) {
            console.log("Building Dynamic Splat Mesh ...")
        }
        const buildStart = performance.now();

        this.disposeMeshData();
        this.scenes.forEach((scene) => scene.removeFromParent());
        this.scenes = [];
        this.sceneOptions = [];
        this.residentNodes.clear();
        this.pendingNodeLoads = [];
        this.presortCommandBuffer = presortCommandBuffer || null;

        let totalSplatCount = 0;
        for (let virtualSplatBuffer of virtualSplatBuffers) totalSplatCount += virtualSplatBuffer.getSplatCount();

        //TODO: Use splat budget instead !!
        const maxSplatCount = maxRenderSplatCount || Math.max(totalSplatCount, 1);
        this.minSphericalHarmonicsDegree = 0; // TODO: ADD SH support

        this.geometry = SplatGeometry.build(maxSplatCount);
        if (this.splatRenderMode === SplatRenderMode.ThreeD) {
            this.material = SplatMaterial3D.build(this.dynamicMode, this.enableOptionalEffects, this.antialiased,
                this.maxScreenSpaceSplatSize, this.splatScale, this.pointCloudModeEnabled,
                this.minSphericalHarmonicsDegree, this.kernel2DSize);
        } else {
            this.material = SplatMaterial2D.build(this.dynamicMode, this.enableOptionalEffects,
                this.splatScale, this.pointCloudModeEnabled, this.minSphericalHarmonicsDegree);
        }

        // Reveal fade-in disabled:
        this.material.uniforms.fadeInComplete.value = 1;

        // The data textures are (re)created on the next onBeforeRender(), when a renderer is available
        this.splatAllocator.disposeTextures();
        this.splatAllocatorReady = false;
        this.maxSplatCount = maxSplatCount;

        this.baseSplatTree = new SplatTree(12, 1000);

        // TODO: Push a subtree if its node is loaded
        for (let i = 0; i < virtualSplatBuffers.length; i++) {
            this.pushSplatScene(virtualSplatBuffers[i], sceneOptions[i]);
        }

        this.splatTree = this.baseSplatTree;

        // Request the root node of every scene. The nodes are uploaded on the next onBeforeRender().
        // Every loaded node also pushes its centers + scene indexes into the presort command buffer (see loadSplatNode()),
        // at the node's global splat indexes, this is how the sort worker knows about the splat positions.

        // TODO: Dont duplicate the data loading. get the centers from the previous GPU Texture upload step, then add them to the worker
        // The worker needs to keep its own pool of data and update whenever there is a GPU Texture upload
        // ----------------> How to pass data to the worker efficiently ???
        for (let i = 0; i < this.scenes.length; i++) {
            this.requestSplatNodeLoad(i, 0, 0, 0, 0);
        }

        this.updateTransforms();

        this.visible = (this.scenes.length > 0);

        if (this.logLevel >= LogLevel.Info) {
            console.log(`Dynamic Splat Mesh build: ${(performance.now() - buildStart).toFixed(1)} ms, ${this.pendingNodeLoads.length} pending nodes`);
        }

        if (this.onSplatTreeReadyCallback) this.onSplatTreeReadyCallback(this.splatTree);
        this.onSplatTreeReadyCallback = null;
    }

    /**
     * Push a new scene to be loaded into this mesh. Only creates the scene and its subtree, no splat data is loaded.
     * @param {VirtualSplatBuffer} virtualSplatBuffer The base splat data
     * @param {object} sceneOptions See build()
     * @return {SplatScene}
     */
    pushSplatScene(virtualSplatBuffer, sceneOptions) {
        if (this.scenes.length >= Constants.MaxScenes) {
            console.error(`DynamicSplatMesh::pushSplatScene() -> at most ${Constants.MaxScenes} scenes are supported`);
            return null;
        }
        const options = sceneOptions || {};
        let positionArray = options['position'] || [0, 0, 0];
        let rotationArray = options['rotation'] || [0, 0, 0, 1];
        let scaleArray = options['scale'] || [1, 1, 1];
        const position = new THREE.Vector3().fromArray(positionArray);
        const rotation = new THREE.Quaternion().fromArray(rotationArray);
        const scale = new THREE.Vector3().fromArray(scaleArray);
        const scene = new SplatScene(virtualSplatBuffer.splatBuffer, position, rotation, scale,
            options.splatAlphaRemovalThreshold || 1, options.opacity, options.visible);
        scene.virtualSplatBuffer = virtualSplatBuffer;
        const parent = options.parent ?? this;
        parent.add(scene);
        this.scenes.push(scene);
        this.sceneOptions.push(options);

        //
        // TODO: Load only the root subtree
        //  -subtrees should have pointers to all other child subtrees as well (for 3D tile conformance)
        //  -The loading of new subtrees will be driven by checking the requested level
        //
        const rootSubtreeData = virtualSplatBuffer.getSplatSubtreeData(0, 0, 0, 0);
        const subtree = new SplatSubTree(this.baseSplatTree.maxDepth, this.baseSplatTree.maxCentersPerNode);
        subtree.splatMesh = this;
        if (rootSubtreeData) {
            subtree.sceneMin.copy(rootSubtreeData.min);
            subtree.sceneMax.copy(rootSubtreeData.max);
            const rootNodeData = rootSubtreeData.nodes[0];
            const rootNode = new SplatTreeNode(rootNodeData.min, rootNodeData.max, 0, 0);
            rootNode.numSplats = rootNodeData.splatCount;
            rootNode.tileCoords = { level: 0, x: 0, y: 0, z: 0 };
            rootNode.resident = false;
            subtree.rootNode = rootNode;
        }
        scene.subtree = subtree;
        this.baseSplatTree.subTrees.push(subtree);

        return scene;
    }

    /**
     * Loading
     */
    static getResidentNodeKey(sceneIndex, level, x, y, z) {
        return `${sceneIndex}:${VirtualSplatBuffer.getNodeKey(level, x, y, z)}`;
    }

    /**
     * Queues a node to be loaded on the next onBeforeRender(). The CPU side work (decoding and packing the node data)
     * is done right away, so only the allocation and the GPU upload happen during rendering.
     * @param {number} sceneIndex
     * @param {number} level
     * @param {number} x
     * @param {number} y
     * @param {number} z
     */
    requestSplatNodeLoad(sceneIndex, level, x, y, z) {
        const key = DynamicSplatMesh.getResidentNodeKey(sceneIndex, level, x, y, z);
        if (this.residentNodes.has(key)) return;
        for (const pending of this.pendingNodeLoads) {
            if (DynamicSplatMesh.getResidentNodeKey(pending.sceneIndex, pending.level, pending.x, pending.y, pending.z) === key) return;
        }

        // Pack now (VirtualSplatBuffer caches the packed data until loadSplatNode() releases it)
        const scene = this.scenes[sceneIndex];
        scene.virtualSplatBuffer.getSplatNodeData(level, x, y, z, this.splatAllocator.getSplatDataFormat(), scene.minimumAlpha);

        this.pendingNodeLoads.push({ sceneIndex, level, x, y, z });
    }

    /**
     * Called by three.js right before this mesh is drawn, with the renderer that draws it. 
     */
    onBeforeRender(renderer) {
        if (this.pendingNodeLoads.length === 0) return;
        this.renderer = renderer;
        this.flushPendingNodeLoads();
    }

    /**
     * Creates the data textures if needed and uploads every pending node.
     * TODO: Limit the number of nodes/pages uploaded per frame once nodes are streamed
     */
    flushPendingNodeLoads() {
        if (!this.renderer || this.pendingNodeLoads.length === 0) return;

        if (!this.splatAllocatorReady) {
            const setupStart = performance.now();
            this.splatAllocator.setup(this.renderer, this.material, this.maxSplatCount);
            this.splatAllocator.setSceneCount(this.scenes.length);
            this.splatAllocatorReady = true;
            if (this.logLevel >= LogLevel.Info) {
                console.log(`DynamicSplatMesh: GPU data textures created in ${(performance.now() - setupStart).toFixed(1)} ms`);
            }
        }

        const pendingNodeLoads = this.pendingNodeLoads;
        this.pendingNodeLoads = [];
        let loadedCount = 0;
        for (const pending of pendingNodeLoads) {
            if (this.loadSplatNode(pending.sceneIndex, pending.level, pending.x, pending.y, pending.z, true)) loadedCount++;
        }

        if (loadedCount > 0 && this.onNodesLoadedCallback) this.onNodesLoadedCallback(this);
    }

    /**
     * Fetches the packed data of a node, allocates GPU memory for it, writes it into the staging buffer and submits it.
     * Requires the GPU data textures to be setup.
     * @param {number} sceneIndex
     * @param {number} level
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {boolean} releaseNodeData drop the CPU copy of the packed node data after the upload
     * @return {Object | null} the resident node record, or null if the node does not exist or memory ran out
     */
    loadSplatNode(sceneIndex, level, x, y, z, releaseNodeData = true) {
        if (!this.splatAllocatorReady) {
            console.error('DynamicSplatMesh::loadSplatNode(): GPU data textures are not ready, use requestSplatNodeLoad() instead');
            return null;
        }
        const key = DynamicSplatMesh.getResidentNodeKey(sceneIndex, level, x, y, z);
        const existing = this.residentNodes.get(key);
        if (existing) return existing;

        const scene = this.scenes[sceneIndex];
        const virtualSplatBuffer = scene.virtualSplatBuffer;

        const loadStart = performance.now();
        const nodeData = virtualSplatBuffer.getSplatNodeData(level, x, y, z, this.splatAllocator.getSplatDataFormat(), scene.minimumAlpha);

        if (!nodeData) return null;

        const packTime = performance.now() - loadStart;

        const stagingBuffer = this.splatAllocator.allocate(nodeData.splatCount);
        if (!stagingBuffer) {
            console.error(`DynamicSplatMesh: out of GPU splat memory while loading node ${key} (${nodeData.splatCount} splats)`);
            return null;
        }
        stagingBuffer.writeNodeData(nodeData, sceneIndex);
        stagingBuffer.submit();

        // Send the splat positions of this node to the sort worker, stored at the node's global splat indexes
        this.submitNodeDataForDistancesComputation(stagingBuffer.splatOffset, nodeData, sceneIndex);

        if (releaseNodeData) virtualSplatBuffer.releaseSplatNodeData(level, x, y, z);

        //
        // TODO: Setup for loadin any node, not just the root !
        //
        const node = (level === 0 && scene.subtree.rootNode) ? scene.subtree.rootNode : null;
        if (node) {
            node.resident = true;
            node.splatOffset = stagingBuffer.splatOffset;

            // The Viewer (gatherSceneNodesForSort) reads the global splat indexes of a node from here
            // TODO: DONT ALLOCATE A NEW Array EVERY TIME. USE THE ONE WE BOUND TO THE GEOMETRY !!!
            const indexes = new Uint32Array(nodeData.splatCount);
            for (let i = 0; i < nodeData.splatCount; i++) indexes[i] = stagingBuffer.splatOffset + i;
            node.data = { 'indexes': indexes };
        }

        const record = {
            sceneIndex, level, x, y, z,
            node,
            stagingBuffer,
            splatOffset: stagingBuffer.splatOffset,
            splatCount: nodeData.splatCount
        };
        this.residentNodes.set(key, record);

        if (this.logLevel >= LogLevel.Info) {
            console.log(`DynamicSplatMesh: loaded node ${key}: ${nodeData.splatCount} splats at offset ` +
                `${stagingBuffer.splatOffset} (pack ${packTime.toFixed(1)} ms, ` +
                `pack + upload ${(performance.now() - loadStart).toFixed(1)} ms)`);
        }
        return record;
    }

    /**
     * Frees the GPU memory of a resident node. The caller must make sure the node's splats are no longer part of the
     * render index list.
     */
    unloadSplatNode(sceneIndex, level, x, y, z) {
        const key = DynamicSplatMesh.getResidentNodeKey(sceneIndex, level, x, y, z);
        const record = this.residentNodes.get(key);
        if (!record) return;
        this.splatAllocator.free(record.stagingBuffer);
        if (record.node) {
            record.node.resident = false;
            record.node.splatOffset = undefined;
            record.node.data = null;
        }
        this.residentNodes.delete(key);
        //TODO: The sort worker keeps the stale centers of the freed range. That is fine as long as the freed indexes
        // are never part of the indexes to sort, they are overwritten when the range is allocated again.
    }

    /**
     * Sort worker
     */

    /**
     * Get copies of data that are necessary for splat distance computation: splat center positions (untransformed,
     * padded to 4 components) and splat scene indexes. Same format as SplatMesh.getDataForDistancesComputation().
     * @param {Object} nodeData packed node data from VirtualSplatBuffer.getSplatNodeData()
     * @param {number} sceneIndex
     * @return {{centers: (Int32Array|Float32Array), sceneIndexes: Uint32Array}}
     */
    getDataForDistancesComputation(nodeData, sceneIndex) {
        const splatCount = nodeData.splatCount;
        const srcCenters = nodeData.centers;
        let centers;
        if (this.integerBasedDistancesComputation) {
            centers = new Int32Array(splatCount * 4);
            for (let i = 0; i < splatCount; i++) {
                for (let t = 0; t < 3; t++) {
                    centers[i * 4 + t] = Math.round(srcCenters[i * 3 + t] * 1000.0);
                }
                centers[i * 4 + 3] = 1000;
            }
        } else {
            centers = new Float32Array(splatCount * 4);
            for (let i = 0; i < splatCount; i++) {
                for (let t = 0; t < 3; t++) {
                    centers[i * 4 + t] = srcCenters[i * 3 + t];
                }
                centers[i * 4 + 3] = 1.0;
            }
        }
        const sceneIndexes = new Uint32Array(splatCount).fill(sceneIndex);
        return {
            centers,
            sceneIndexes
        };
    }

    /**
     * Pushes the centers and scene indexes of a loaded node to the sort worker through the presort command buffer.
     * The data is stored in the worker at the global splat indexes [splatOffset, splatOffset + splatCount).
     * 
     * TODO: FIX The sort worker clamping the render count to (from + count) of the LAST upload it received, so uploads must
     * currently happen in increasing offset order (true while only root nodes are loaded in build()). FIX THIS
     * ALLOW FOR WHOLE SUBTREES TO BE UPLOADED WITH THE SAME OFFSETS. Each subtree is an independent atomic memory block
     * 
     * @param {number} splatOffset global splat index of the first splat of the node
     * @param {Object} nodeData packed node data
     * @param {number} sceneIndex
     */
    submitNodeDataForDistancesComputation(splatOffset, nodeData, sceneIndex) {
        if (!this.presortCommandBuffer) {
            if (this.logLevel >= LogLevel.Info) {
                console.warn('DynamicSplatMesh: no presort command buffer, the sort worker will not receive the splat centers');
            }
            return;
        }
        const { centers, sceneIndexes } = this.getDataForDistancesComputation(nodeData, sceneIndex);
        const updateMessage = {
            'centers': centers.buffer,
            'sceneIndexes': sceneIndexes.buffer,
            'range': {
                'from': splatOffset,
                'to': splatOffset + nodeData.splatCount - 1,
                'count': nodeData.splatCount
            }
        }
        this.presortCommandBuffer.pushCommand(updateMessage);
    }

    /**
     * Rendering
     */

    /**
     * Set the indexes of splats that should be rendered; should be sorted in desired render order.
     * The indexes are global splat indexes of this mesh (allocation offset + index inside the node), as produced by the
     * sort worker.
     * @param {Uint32Array} globalIndexes Sorted index list of splats to be rendered
     * @param {number} renderSplatCount Number of valid entries in globalIndexes
     */
    updateRenderIndexes(globalIndexes, renderSplatCount) {
        const geometry = this.geometry;
        const splatIndexAttribute = geometry.attributes.splatIndex;
        const count = Math.min(renderSplatCount, splatIndexAttribute.array.length);

        // The sorted indexes array of the sort worker can be larger than our index buffer
        splatIndexAttribute.set(globalIndexes.subarray(0, count));
        splatIndexAttribute.needsUpdate = true;

        //TODO: only upload the used range: splatIndexAttribute.addUpdateRange(0, count) (three r159+)
        geometry.instanceCount = count;
        geometry.setDrawRange(0, count);
        this.renderSplatCount = count;
        if (count > 0 && this.firstRenderTime === -1) this.firstRenderTime = performance.now();
    }

    /**
     * Update the transforms for each scene in this splat mesh from their individual components (position,
     * quaternion, and scale)
     */
    updateTransforms() {
        for (let i = 0; i < this.scenes.length; i++) {
            this.scenes[i].updateTransform(this.dynamicMode);
        }
    }

    /**
     * Fill the given array with the transforms for each scene in this splat mesh (used by the sort worker).
     * @param {Array} array Empty array to be filled with scene transforms. If not empty, contents will be overwritten.
     */
    fillTransformsArray(array) {
        for (let i = 0; i < this.scenes.length; i++) {
            array.set(this.scenes[i].transform.elements, i * 16);
        }
    }

    /**
     * The reveal fade-in of SplatMesh is not supported, this only keeps the fade-in uniforms disabled.
     */
    updateVisibleRegionFadeDistance(sceneRevealMode) {
        if (!this.material || this.material === Constants.dummyMaterial) return;
        this.material.uniforms.fadeInComplete.value = 1;
        this.material.uniforms.currentTime.value = performance.now();
        this.material.uniformsNeedUpdate = true;
        this.visibleRegionChanging = false;
    }

    updateUniforms = function () {

        const viewport = new THREE.Vector2();

        return function (renderDimensions, cameraFocalLengthX, cameraFocalLengthY,
            orthographicMode, orthographicZoom, inverseFocalAdjustment) {
            if (!this.material || this.getSplatCount() <= 0) return;
            const uniforms = this.material.uniforms;
            viewport.set(renderDimensions.x * this.devicePixelRatio,
                renderDimensions.y * this.devicePixelRatio);
            uniforms.viewport.value.copy(viewport);
            uniforms.basisViewport.value.set(1.0 / viewport.x, 1.0 / viewport.y);
            uniforms.focal.value.set(cameraFocalLengthX, cameraFocalLengthY);
            uniforms.orthographicMode.value = orthographicMode ? 1 : 0;
            uniforms.orthoZoom.value = orthographicZoom;
            uniforms.inverseFocalAdjustment.value = inverseFocalAdjustment;
            uniforms.fadeInComplete.value = 1;
            uniforms.currentTime.value = performance.now();
            for (let i = 0; i < this.scenes.length; i++) {
                uniforms.transforms.value[i].copy(this.scenes[i].transform);
            }
            if (this.enableOptionalEffects) {
                for (let i = 0; i < this.scenes.length; i++) {
                    uniforms.sceneOpacity.value[i] = clamp(this.scenes[i].opacity, 0.0, 1.0);
                    uniforms.sceneVisibility.value[i] = this.scenes[i].visible ? 1 : 0;
                }
            }
            this.material.uniformsNeedUpdate = true;
        };

    }();

    setSplatScale(splatScale = 1) {
        this.splatScale = splatScale;
        if (this.material) {
            this.material.uniforms.splatScale.value = splatScale;
            this.material.uniformsNeedUpdate = true;
        }
    }

    getSplatScale() {
        return this.splatScale;
    }

    setPointCloudModeEnabled(enabled) {
        this.pointCloudModeEnabled = enabled;
        if (this.material) {
            this.material.uniforms.pointCloudModeEnabled.value = enabled ? 1 : 0;
            this.material.uniformsNeedUpdate = true;
        }
    }

    getPointCloudModeEnabled() {
        return this.pointCloudModeEnabled;
    }

    /**
     * Accessors
     */

    /**
     * @return {number} number of splats currently resident on the GPU
     */
    getSplatCount() {
        let count = 0;
        for (const record of this.residentNodes.values()) count += record.splatCount;
        return count;
    }

    /**
     * Highest global splat index in use + 1. The sort worker stores centers at the global splat indexes, so it has to
     * be allocated with (at least) this many splats.
     * @return {number}
     */
    getMaxSplatCount() {
        let maxSplatCount = 0;
        for (const record of this.residentNodes.values()) {
            maxSplatCount = Math.max(maxSplatCount, record.splatOffset + record.splatCount);
        }
        return maxSplatCount;
    }

    getSplatTree() {
        return this.splatTree;
    }

    getSceneTransform(sceneIndex, outTransform) {
        const scene = this.scenes[sceneIndex];
        scene.updateTransform(this.dynamicMode);
        outTransform.copy(scene.transform);
    }

    /**
     * Disposal
     */

    disposeMeshData() {
        if (this.geometry && this.geometry !== Constants.dummyGeometry) {
            this.geometry.dispose();
            this.geometry = Constants.dummyGeometry;
        }
        if (this.material && this.material !== Constants.dummyMaterial) {
            this.material.dispose();
            this.material = Constants.dummyMaterial;
        }
    }

    dispose() {
        this.disposeMeshData();
        if (this.splatAllocator && this.splatAllocator.splatTextureDescriptors) {
            this.splatAllocator.disposeTextures();
        }
        if (this.baseSplatTree) {
            this.baseSplatTree.dispose();
            this.baseSplatTree = null;
        }
        this.scenes.forEach((scene) => scene.removeFromParent());
        this.scenes = [];
        this.sceneOptions = [];
        this.residentNodes.clear();
        this.pendingNodeLoads = [];
        this.splatAllocatorReady = false;
        this.onNodesLoadedCallback = null;
        this.presortCommandBuffer = null;
        this.renderer = null;
        this.disposed = true;
        this.visible = false;
    }
}