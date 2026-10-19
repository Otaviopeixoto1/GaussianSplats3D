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
import {SceneFormat} from "../loaders/SceneFormat.js";



/**
 * TODO: Manage Nodes and subtrees. Currently we just load the root nodes
 */
export class DynamicSplatMesh extends THREE.Mesh {

    //TODO: Compact this into some kind of EngineSettings interface...
    constructor(halfPrecisionCovariancesOnGPU = false, devicePixelRatio = 1, enableDistancesComputationOnGPU = true,
        integerBasedDistancesComputation = false, antialiased = false, maxScreenSpaceSplatSize = 1024, logLevel = LogLevel.None,
        sphericalHarmonicsDegree = 0, sceneFadeInRateMultiplier = 1.0, kernel2DSize = 0.3, maxResidentSplats = 4194304) {
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
        // Not used by this mesh: the sort worker converts the node centers it receives to its own format.
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
        // Fixed size of the splat index space: every allocated splat index is below this value. The sort worker is
        // created once with this capacity (see getMaxSplatCount()), so it never has to be resized.
        this.maxResidentSplats = maxResidentSplats;
        // The current total splat count loaded by this mesh
        this.currentSplatCount = 0;
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
     * @param {number} maxRenderSplatCount Size of the splat index buffer. Defaults to the total splat count of the virtual splat buffers.
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
        this.pendingNodeLoads = [];
        this.presortCommandBuffer = presortCommandBuffer || null;

        //Validate. DynamicMesh only supports .kstree files, any other format cannot be loaded
        for(const options of sceneOptions) {
            if (options.format !== SceneFormat.KSTree) {
                console.error(`DynamicSplatMesh::build: Scene format: ${options.format}. DynamicSplatMesh ony works with .kstree format (${SceneFormat.KSTree})`)
            }
        }

        for (let virtualSplatBuffer of virtualSplatBuffers) {
            virtualSplatBuffer.setFormat(this.splatAllocator.getSplatDataFormat());
        }

        //TODO: Use splat budget instead !!
        const maxSplatCount = maxRenderSplatCount;
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

        this.baseSplatTree = new SplatTree(12, 1000);

        const sceneLoadPromises = [];
        for (let i = 0; i < virtualSplatBuffers.length; i++) {
            sceneLoadPromises.push(this.pushSplatScene(i, virtualSplatBuffers[i], sceneOptions[i]));
        }

        this.updateTransforms();

        this.visible = (this.scenes.length > 0);

        if (this.logLevel >= LogLevel.Info) {
            console.log(`Dynamic Splat Mesh build: ${(performance.now() - buildStart).toFixed(1)} ms, ${this.pendingNodeLoads.length} pending nodes`);
        }

        Promise.all(sceneLoadPromises).then(() => {
            this.splatTree = this.baseSplatTree;
            this.baseSplatTree.subTrees.length = sceneLoadPromises.length;

            // Request the root node of every scene. The nodes are uploaded on the next onBeforeRender().
            // Every loaded node also pushes its centers + scene indexes into the presort command buffer (see loadSplatNode()),
            // at the node global splat indexes.
            for (let i = 0; i < this.scenes.length; i++) {
                this.requestSplatNodeLoad(i, this.scenes[i].subtree.rootNode);
            }

            if (this.onSplatTreeReadyCallback) this.onSplatTreeReadyCallback(this.splatTree);
            this.onSplatTreeReadyCallback = null;
        })
    }

    /**
     * Push a new scene to be loaded into this mesh. Only creates the scene and its subtree, no splat data is loaded.
     * @param {number} sceneIndex The base splat data
     * @param {VirtualSplatBuffer} virtualSplatBuffer The base splat data
     * @param {object} sceneOptions See build()
     * @return {Promise<void>}
     */
    async pushSplatScene(sceneIndex, virtualSplatBuffer, sceneOptions) {
        if (this.scenes.length >= Constants.MaxScenes) {
            console.error(`DynamicSplatMesh::pushSplatScene: at most ${Constants.MaxScenes} scenes are supported`);
            return;
        }
        const options = sceneOptions || {};
        let positionArray = options['position'] || [0, 0, 0];
        let rotationArray = options['rotation'] || [0, 0, 0, 1];
        let scaleArray = options['scale'] || [1, 1, 1];
        const position = new THREE.Vector3().fromArray(positionArray);
        const rotation = new THREE.Quaternion().fromArray(rotationArray);
        const scale = new THREE.Vector3().fromArray(scaleArray);
        const scene = new SplatScene(virtualSplatBuffer, position, rotation, scale,
            options.splatAlphaRemovalThreshold || 1, options.opacity, options.visible);
        const parent = options.parent ?? this;
        parent.add(scene);
        this.scenes.push(scene);
        this.sceneOptions.push(options);

        // Get root subtree:
        const subtree = await virtualSplatBuffer.getSplatSubtree(0, 0, 0, 0);
        subtree.splatMesh = this;
        scene.subtree = subtree;
        this.baseSplatTree.subTrees[sceneIndex] = subtree;

        return;
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
     * Queues a node to be loaded on the next onBeforeRender(). The CPU side work (decoding and packing the node data)
     * is done right away, so only the allocation and the GPU upload happen during rendering.
     * @param {number} sceneId
     * @param {SplatTreeNode} node
     */
    requestSplatNodeLoad(sceneId,  node) {
        // TODO: limit the number of valid requests. Validate them and maybe batch allocs
        //  Only leave alloc pending if validated

        node.allocation.pending = true;
        this.pendingNodeLoads.push({ sceneId, node });
    }

    /**
     * Creates the data textures if needed and uploads every pending node.
     * TODO: Limit the number of nodes/pages uploaded per frame once nodes are streamed
     */
    flushPendingNodeLoads() {
        if (!this.renderer || this.pendingNodeLoads.length === 0) return;

        if (!this.splatAllocatorReady) {
            const setupStart = performance.now();
            this.splatAllocator.setup(this.renderer, this.material, this.maxResidentSplats);
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
            if (this.loadSplatNode(pending.sceneId, pending.node, true)) loadedCount++;
        }

        if (loadedCount > 0 && this.onNodesLoadedCallback) this.onNodesLoadedCallback(this);
    }

    /**
     * Fetches the packed data of a node, allocates GPU memory for it, writes it into the staging buffer and submits it.
     * Requires the GPU data textures to be setup.
     * @param {number} sceneIndex
     * @param {SplatTreeNode} node
     * @param {boolean} releaseNodeData drop the CPU copy of the packed node data after the upload
     * @return {boolean} true when a node was successfully loaded
     */
    loadSplatNode(sceneIndex, node, releaseNodeData = true) {
        if (!this.splatAllocatorReady) {
            console.error('DynamicSplatMesh::loadSplatNode(): GPU data textures are not ready, use requestSplatNodeLoad() instead');
            return false;
        }

        console.log("DynamicSplatMesh: LOADING", node)

        const loadStart = performance.now();
        const scene = this.scenes[sceneIndex];
        const virtualSplatBuffer = scene.splatBuffer;

        //
        // TODO:
        //  --[] Make the viewer call requestSplatNodeLoad(). (LAST THING)
        //
        const level = node.level;
        const {x, y, z} = node.key;


        virtualSplatBuffer.getSplatNodeData(level, x, y, z, scene.minimumAlpha).then((nodeData) => {
            if (!nodeData) return;

            const packTime = performance.now() - loadStart;

            const stagingBuffer = this.splatAllocator.allocate(nodeData.splatCount);
            if (!stagingBuffer) {
                console.error(`DynamicSplatMesh: out of GPU splat memory while loading node ${key} (${nodeData.splatCount} splats)`);
                return;
            }
            stagingBuffer.writeNodeData(nodeData, sceneIndex);
            stagingBuffer.submit(node.allocation);

            // Send the splat centers of this node to the sort worker, stored at the node global splat indexes.
            // If releaseNodeData is true (default) This centers buffer is transferred (not copied) to the worker
            const centers = releaseNodeData ? nodeData.centers : nodeData.centers.slice();
            this.submitNodeDataForDistancesComputation(stagingBuffer.splatOffset, nodeData.splatCount, centers, sceneIndex);

            if (releaseNodeData) virtualSplatBuffer.releaseSplatNodeData(level, x, y, z);

            // The Viewer (gatherSceneNodesForSort) reads the global splat indexes of a node from here
            // TODO: DONT ALLOCATE A NEW Array EVERY TIME. USE THE ONE WE BOUND TO THE GEOMETRY !!!
            const indexes = new Uint32Array(nodeData.splatCount);
            for (let i = 0; i < nodeData.splatCount; i++) indexes[i] = stagingBuffer.splatOffset + i;
            node.data = { 'indexes': indexes }; //TODO: THE NODE DOESNT EVEN NEED TO HOLD THE INDEXES LIKE THIS !!! (just the range)


            if (this.logLevel >= LogLevel.Info) {
                console.log(`DynamicSplatMesh: loaded node (${level}, ${x}, ${y}, ${z}): ${nodeData.splatCount} splats `);
                console.log(`offset: ${stagingBuffer.splatOffset} (pack ${packTime.toFixed(1)} ms`);
                console.log(`pack + upload ${(performance.now() - loadStart).toFixed(1)} ms)`);
            }

            this.currentSplatCount += node.numSplats;
            console.log("NODE ALLOC", node.allocation);
        });

        return true;
    }

    /**
     * Frees the GPU memory of a resident node. The caller must make sure the node's splats are no longer part of the
     * render index list.
     *
     * TODO: The unloading of nodes should not be done this way. Each node will keep an allocation ref and have a free() method
     */
    unloadSplatNode(node) {
        this.splatAllocator.free(node.allocation);
        node.allocation.resident = false;
        node.allocation.pending = false;
        node.allocation.splatOffset = -1;
        node.allocation.textureAllocations = null;

        this.currentSplatCount -= node.numSplats;

        //
        // The sort worker keeps the stale centers of the freed range. That is fine as long as the freed indexes
        // are never part of the indexes to sort, they are overwritten when the range is allocated again.
        //
    }

    /**
     * Sort worker
     */

    /**
     * Pushes the centers and scene index of a loaded node to the sort worker through the presort command buffer.
     * The data is stored in the worker at the global splat indexes [splatOffset, splatOffset + splatCount). The worker
     * converts the centers to its own format and fills the scene indexes, nodes can be uploaded in any order.
     *
     * TODO: ALLOW FOR WHOLE SUBTREES TO BE UPLOADED WITH THE SAME OFFSETS. Each subtree is an independent atomic memory block
     *
     * @param {number} splatOffset global splat index of the first splat of the node
     * @param {number} splatCount
     * @param {Float32Array} centers 3 floats per splat, its buffer is transferred to the worker (unusable afterwards)
     * @param {number} sceneIndex
     */
    submitNodeDataForDistancesComputation(splatOffset, splatCount, centers, sceneIndex) {
        if (!this.presortCommandBuffer) {
            if (this.logLevel >= LogLevel.Info) {
                console.warn('DynamicSplatMesh: no presort command buffer, the sort worker will not receive the splat centers');
            }
            return;
        }
        const updateMessage = {
            'nodeCenters': {
                'from': splatOffset,
                'count': splatCount,
                'sceneIndex': sceneIndex,
                'centers': centers.buffer
            }
        }
        this.presortCommandBuffer.pushCommand(updateMessage, undefined, [centers.buffer]);
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
        if (!this.geometry || this.geometry === Constants.dummyGeometry) return;
        const splatIndexAttribute = this.geometry.attributes.splatIndex;
        const count = Math.min(renderSplatCount, splatIndexAttribute.array.length);

        // The sorted indexes array of the sort worker can be larger than our index buffer
        splatIndexAttribute.set(globalIndexes.subarray(0, count));
        splatIndexAttribute.needsUpdate = true;

        //TODO: only upload the used range: splatIndexAttribute.addUpdateRange(0, count) (three r159+)
        this.geometry.instanceCount = count;
        this.geometry.setDrawRange(0, count);
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
        return this.currentSplatCount;
    }

    /**
     * Size of the splat index space (fixed). The sort worker stores centers at the global splat indexes, so it is
     * allocated with this many splats. GPUSplatAllocator never hands out a splat index at or above this value.
     * @return {number}
     */
    getMaxSplatCount() {
        return this.maxResidentSplats;
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
        this.pendingNodeLoads = [];
        this.splatAllocatorReady = false;
        this.onNodesLoadedCallback = null;
        this.presortCommandBuffer = null;
        this.renderer = null;
        this.disposed = true;
        this.visible = false;
    }
}