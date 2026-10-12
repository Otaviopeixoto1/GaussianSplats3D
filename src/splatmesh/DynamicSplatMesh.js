import * as THREE from "three";
import {Constants} from "../Constants.js";
import {LogLevel} from "../LogLevel.js";
import {SplatRenderMode} from "../SplatRenderMode.js";
import {SplatGeometry} from "./SplatGeometry.js";
import {SplatMaterial3D} from "./SplatMaterial3D.js";
import {SplatMaterial2D} from "./SplatMaterial2D.js";
import {SplatSubTree, SplatTree} from "../splattree/SplatTree.js";
import {KSplatHeader} from "../loaders/SplatBuffer.js";
import {KSplatTreeBuffer} from "../loaders/ksplat/KSplatTreeLoader.js";
import {getSphericalHarmonicsComponentCountForDegree} from "../Util.js";
import {GPUSplatAllocator} from '../LOD/GPUSplatAllocator.js'



//TODO: This class will manage all dynamic resources like DynamicScenes and VirtualSplatBuffers + SpatSubTrees
// This mesh is meant update the SplatNodeManager and GPUSplatAllocator every frame with potentially new splats...


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

        //TODO: Fix the compression level to the maximum compression level of all splat buffers that are used
        this.splatAlloctator = new GPUSplatAllocator(this.splatRenderMode, halfPrecisionCovariancesOnGPU, 0);

        // Ratio of the resolution in physical pixels to the resolution in CSS pixels for the current display device
        this.devicePixelRatio = devicePixelRatio;

        // Use a transform feedback to calculate splat distances from the camera
        this.enableDistancesComputationOnGPU = enableDistancesComputationOnGPU;

        // Use a faster integer-based approach for calculating splat distances from the camera
        this.integerBasedDistancesComputation = integerBasedDistancesComputation;

        // When true, will perform additional steps during rendering to address artifacts caused by the rendering of gaussians at a
        // substantially different resolution than that at which they were rendered during training. This will only work correctly
        // for models that were trained using a process that utilizes this compensation calculation. For more details:
        // https://github.com/nerfstudio-project/gsplat/pull/117
        // https://github.com/graphdeco-inria/gaussian-splatting/issues/294#issuecomment-1772688093
        this.antialiased = antialiased;

        // The size of the 2D kernel used for splat rendering
        // This will adjust the 2D kernel size after the projection
        this.kernel2DSize = kernel2DSize;

        // Specify the maximum clip space splat size, can help deal with large splats that get too unwieldy
        this.maxScreenSpaceSplatSize = maxScreenSpaceSplatSize;

        // The verbosity of console logging
        this.logLevel = logLevel;

        // Degree 0 means no spherical harmonics
        this.sphericalHarmonicsDegree = sphericalHarmonicsDegree;
        this.minSphericalHarmonicsDegree = 0;

        this.sceneFadeInRateMultiplier = sceneFadeInRateMultiplier;

        // The individual splat scenes stored in this splat mesh, each containing their own transform
        this.scenes = [];

        // Special octree tailored to SplatMesh instances
        //TODO: store octree on the scene itself...
        this.splatTree = null;
        this.baseSplatTree = null;

        // Cache textures and the intermediate data used to populate them
        this.splatDataTextures = {};

        this.distancesTransformFeedback = {
            'id': null,
            'vertexShader': null,
            'fragmentShader': null,
            'program': null,
            'centersBuffer': null,
            'sceneIndexesBuffer': null,
            'outDistancesBuffer': null,
            'centersLoc': -1,
            'modelViewProjLoc': -1,
            'sceneIndexesLoc': -1,
            'transformsLocs': []
        };

        //
        // TODO: Rework splat indexing. 
        //
        this.globalSplatIndexToLocalSplatIndexMap = [];
        this.globalSplatIndexToSceneIndexMap = [];

        this.lastBuildSceneCount = 0;
        this.lastBuildSplatCount = 0;
        this.lastBuildMaxSplatCount = 0;
        this.firstRenderTime = -1;

        this.webGLUtils = null;

        this.boundingBox = new THREE.Box3();
        this.calculatedSceneCenter = new THREE.Vector3();
        this.maxSplatDistanceFromSceneCenter = 0;
        this.visibleRegionBufferRadius = 0;
        this.visibleRegionRadius = 0;
        this.visibleRegionFadeStartRadius = 0;
        this.visibleRegionChanging = false;

        this.splatScale = 1.0;
        this.pointCloudModeEnabled = false;

        this.disposed = false;
        this.lastRenderer = null;
        this.visible = false;
    }

    /**
     *
     * Initialization
     *
     */

    /**
     * Construct this instance of SplatMesh.
     * @param {Array<VirtualSplatBuffer>} virtualSplatBuffers The base splat data, instances of SplatBuffer
     * @param {Array<object>} sceneOptions Dynamic options for each scene {
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     *
     * }
     * @param {boolean=} keepSceneTransforms For a scene that already exists and is being overwritten, this flag
     *                                      says to keep the transform from the existing scene.
     * @param {boolean=} finalBuild Will the splat mesh be in its final state after this build?
     * @param {function} onSplatTreeIndexesUpload Function to be called when the upload of splat centers to the splat tree
     *                                            builder worker starts and finishes.
     * @param {function} onSplatTreeConstruction Function to be called when the conversion of the local splat tree from
     *                                           the format produced by the splat tree builder worker starts and ends.
     * @param {boolean=} preserveVisibleRegion
     * @param {WorkerCommandBuffer} presortCommandBuffer The command buffer used for presort commands
     * @return {object} Object containing info about the splats that are updated
     */
    build(virtualSplatBuffers, sceneOptions, keepSceneTransforms = true, finalBuild = false,
          onSplatTreeIndexesUpload, onSplatTreeConstruction, preserveVisibleRegion = true, presortCommandBuffer) {

        //
        // TODO:
        //  -Work on a basic VirtualSplatBuffer implementation that will for now just contain the actual SplatBuffer
        //


        if (this.logLevel >= LogLevel.Info) {
            console.log("Building Virtual Splat Mesh ...")
        }
        this.sceneOptions = sceneOptions;
        const maxSplatCount = 4000000; //TODO: Add as optional argument

        let minSphericalHarmonicsDegree = 3;
        for (let splatBuffer of splatBuffers) {
            const splatBufferSphericalHarmonicsDegree = splatBuffer.getMinSphericalHarmonicsDegree();
            if (splatBufferSphericalHarmonicsDegree < minSphericalHarmonicsDegree) {
                minSphericalHarmonicsDegree = splatBufferSphericalHarmonicsDegree;
            }
        }
        this.minSphericalHarmonicsDegree = Math.min(minSphericalHarmonicsDegree, this.sphericalHarmonicsDegree);
        this.boundingBox = new THREE.Box3();
        if (!preserveVisibleRegion) {
            this.maxSplatDistanceFromSceneCenter = 0;
            this.visibleRegionBufferRadius = 0;
            this.visibleRegionRadius = 0;
            this.visibleRegionFadeStartRadius = 0;
            this.firstRenderTime = -1;
        }
        this.lastBuildScenes = [];
        this.lastBuildSplatCount = 0;
        this.lastBuildMaxSplatCount = 0;
        this.disposeMeshData();
        this.geometry = SplatGeometry.build(maxSplatCount);
        if (this.splatRenderMode === SplatRenderMode.ThreeD) {
            this.material = SplatMaterial3D.build(this.dynamicMode, this.enableOptionalEffects, this.antialiased,
                this.maxScreenSpaceSplatSize, this.splatScale, this.pointCloudModeEnabled,
                this.minSphericalHarmonicsDegree, this.kernel2DSize);
        } else {
            this.material = SplatMaterial2D.build(this.dynamicMode, this.enableOptionalEffects,
                this.splatScale, this.pointCloudModeEnabled, this.minSphericalHarmonicsDegree);
        }


        // TODO: Dont build index maps here !!
        // const indexMaps = SplatMesh.buildSplatIndexMaps(splatBuffers);
        // this.globalSplatIndexToLocalSplatIndexMap = indexMaps.localSplatIndexMap;
        // this.globalSplatIndexToSceneIndexMap = indexMaps.sceneIndexMap;

        const splatBufferSplatCount = this.getSplatCount(true);
        if (this.enableDistancesComputationOnGPU) this.setupDistancesComputationTransformFeedback();


        //
        //
        //TODO: just initialize/preallocate the textures but dont upload anything into it yet
        // -prealloc to the 16M Splats...
        //
        //
        this.splatAlloctator.setup(this.renderer, this.material, maxSplatCount); //TODO: FIX MaxSplats


        /**
         * Build SplatTree
         */
        this.baseSplatTree = new SplatTree(12, 1000);


        for (let i = 0; i < virtualSplatBuffers.length; i++) {
            this.pushSplatScene(virtualSplatBuffers[i], sceneOptions[i]);
        }
        if (keepSceneTransforms) {
            for (let i = 0; i < this.scenes.length && i < newScenes.length; i++) {
                const newScene = newScenes[i];
                const existingScene = this.getScene(i);
                newScene.copyTransformData(existingScene);
            }
        }

        //
        // TODO: gether the root node data and upload them to the gpu
        //
        for (let i = 0; i < virtualSplatBuffers.length; i++) {
            const rootNodeData = virtualSplatBuffers[i].getSplatNodeData(0, 0, 0, 0);

            //TODO: Upload only this root data to the GPU
            // -Keep in mind that the whole subtree should be preallocated (the indexes are reserved inside the texture)
            // -WE NEED THE GPU ALLOCATOR HERE, IT SHOULD TRACK THE INDEX MAPPING OF THE SUBTREES

            // We need the data to be loaded and already processed for GPU upload

            // TODO: updateBaseDataFromSplatBuffers HAS TO BE REMOVED ENTIRELY. rootNodeData will be already packed correctly
            this.updateBaseDataFromSplatBuffers();
            this.updateDataTexturesFromBaseData(0, currentGlobalOffset - 1);
        }

        //TODO: Dont duplicate the data loading. get the centers from the previous GPU Texture upload step, then add them to the worker
        // The worker needs to keep its own pool of data and update whenever there is a GPU Texture upload
        // ----------------> How to pass data to the worker efficiently ???
        const { centers, sceneIndexes } = this.getDataForDistancesComputation(0, currentGlobalOffset - 1);
        const updateMessage = {
            'centers': centers.buffer,
            'sceneIndexes': sceneIndexes.buffer,
            'range': {
                'from': 0,
                'to': currentGlobalOffset - 1,
                'count': currentGlobalOffset
            }
        }
        presortCommandBuffer.pushCommand(updateMessage);

        if (this.onSplatTreeReadyCallback) this.onSplatTreeReadyCallback(this.splatTree);
        this.onSplatTreeReadyCallback = null;

        this.lastBuildSplatCount = splatBufferSplatCount;
        this.lastBuildMaxSplatCount = this.getMaxSplatCount();
        this.lastBuildSceneCount = this.scenes.length;
        this.visible = (this.scenes.length > 0);
    }

    /**
     * Push a new scene to be loaded into this mesh
     * @param {VirtualSplatBuffer} virtualSplatBuffer The base splat data, instances of SplatBuffer
     * @param {object} sceneOptions Dynamic options for each scene {
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     *
     * }
     * @return {void}
     */
    pushSplatScene(virtualSplatBuffer, sceneOptions) {
        const options = sceneOptions || {};
        let positionArray = options['position'] || [0, 0, 0];
        let rotationArray = options['rotation'] || [0, 0, 0, 1];
        let scaleArray = options['scale'] || [1, 1, 1];
        const position = new THREE.Vector3().fromArray(positionArray);
        const rotation = new THREE.Quaternion().fromArray(rotationArray);
        const scale = new THREE.Vector3().fromArray(scaleArray);
        const scene = SplatMesh.createScene(splatBuffer, position, rotation, scale,
            options.splatAlphaRemovalThreshold || 1, options.opacity, options.visible);
        const parent = options.parent ?? this;
        parent.add(scene);
        this.scenes.push(scene);


        // Init scene subtree:

        //
        // TODO: Load only the root subtree
        //  -Rewrite all the code below to use the rootSubtreeData for loading in the SplatSubTree
        //  --Right now the root subtree will just be the whole tree for a .kstree file. This can be changed later
        //  -subtrees should have pointers to all other child subtrees as well (for 3D tile conformance)
        //  -The loading of new subtrees will be driven by checking the requested level
        //
        const rootSubtreeData = virtualSplatBuffer.getSplatSubtreeData(0, 0, 0, 0);

        //TODO: Bake the totalSplatBufferSize into the .kstree header itself (any such changes should have a new version. We should check for .kstree version when loading)
        const offset = KSplatHeader.calculateTotalSplatBufferSize(scene.splatBuffer);
        const subTreeRoot = KSplatTreeBuffer.deserializeOctreeBuffer(scene.splatBuffer.bufferData, offset);
        const subtree = new SplatSubTree(this.baseSplatTree.maxDepth, this.baseSplatTree.maxCentersPerNode);
        subtree.sceneMin = subTreeRoot.min;
        subtree.sceneMax = subTreeRoot.max;
        subtree.rootNode = subTreeRoot;
        subtree.splatMesh = this;
        this.baseSplatTree.subTrees.push(subtree);
    }



    //TODO: add a limited number of the same accessors from SplatMesh. This will be a much more streamlined class...
    // There should be accessors to splat data from indexes like we have the regular SplatMesh

}