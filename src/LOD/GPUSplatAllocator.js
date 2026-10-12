import * as THREE from "three";
import {Constants} from "../Constants.js";
import {LogLevel} from "../LogLevel.js";
import {SplatRenderMode} from "../SplatRenderMode.js";
import {SplatMaterial3D} from "../splatmesh/SplatMaterial3D.js";
import {SplatMaterial2D} from "../splatmesh/SplatMaterial2D.js";
import {getSphericalHarmonicsComponentCountForDegree} from "../Util.js";
import {WebGLExtensions} from "../three-shim/WebGLExtensions.js";
import {WebGLCapabilities} from "../three-shim/WebGLCapabilities.js";
import {SplatDataPacking} from "./SplatDataPacking.js";



class PagedTexture {

    /**
     * Adds a range of data in the data texture to be updated on the GPU.
     *
     * @param {THREE.DataTexture} texture A Data texture where each row is a page. Must be initialized
     * @param {THREE.WebGLUtils} webGLUtils
     * @param {number} elementsPerTexel
     * @param {number} bytesPerElement
     */
    constructor(texture, webGLUtils, elementsPerTexel, bytesPerElement) {
        this.texture = texture;
        this.currentPage = 0;

        this.glType = webGLUtils.convert(this.texture.type);
        this.glFormat = webGLUtils.convert(this.texture.format, this.texture.colorSpace);

        this.maxPages = texture.image.height;

        this.texelsPerPage = texture.image.width;
        this.elementsPerTexel = elementsPerTexel;
        this.elementsPerPage = this.texelsPerPage * elementsPerTexel;
        this.bytesPerElement = bytesPerElement;

        this._freeAllocs = []
    }

    getData() {
        return this.texture.image.data;
    }

    /**
     * Returns an allocation object with the given range of pages
     * @param {number} startPage
     * @param {number} numPages
     * @return {Object}
     */
    makeAlloc(startPage, numPages) {
        const data = this.getData();
        const byteOffset = data.byteOffset + startPage * this.elementsPerPage * this.bytesPerElement;
        const byteLength = numPages * this.elementsPerPage * this.bytesPerElement;
        const updateDataView = new data.constructor(
            data.buffer,
            byteOffset,
            byteLength / data.BYTES_PER_ELEMENT
        );

        return {
            startPage: startPage,
            endPage: startPage + numPages,
            view: updateDataView
        }
    }

    /**
     * Allocates enough pages to fit the given number of texels
     * @param {number} numTexels
     * @return {Object | null} The allocation object or null if allocation failed
     */
    allocatePages(numTexels) {
        const numPages = Math.ceil(numTexels / this.texelsPerPage);

        // When full, just reuse from the free allocations:
        if (this.currentPage + numPages > this.maxPages) {
            let alloc = null;
            const removedAllocs = []

            for (let i = 0; i < this._freeAllocs.length; i++) {
                const freeAlloc = this._freeAllocs[i];
                const freePageSize = freeAlloc.endPage - freeAlloc.startPage;
                if (freePageSize >= numPages) {
                    alloc = this.makeAlloc(freeAlloc.startPage, numPages);
                    const remaining = freePageSize - numPages;
                    if (remaining > 0) {
                        freeAlloc.startPage = freeAlloc.endPage - remaining;
                    } else {
                        removedAllocs.push(i);
                    }
                    break;
                }
            }

            // TODO: Use a better data structure for storing free allocs
            // For now we iterate back to front for faster removal ...
            for (let r = removedAllocs.length - 1; r >= 0; r--) {
                this._freeAllocs.splice(removedAllocs[r], 1);
            }

            return alloc;
        }

        const allocation = this.makeAlloc(this.currentPage, numPages);
        this.currentPage += numPages;
        return allocation;
    }

    freePages(allocations) {
        //TODO: Free the given allocation list
        this._freeAllocs.push(...allocations);
    }

    /**
     * Returns the index of the first texel of an allocation.
     * @param {Object} allocation
     * @return {number}
     */
    getAllocationStartTexel(allocation) {
        return allocation.startPage * this.texelsPerPage;
    }

    /**
     * Submits allocated and staged pages to the GPU.
     * @param {Object} allocation
     * @param {THREE.WebGLRenderer} renderer
     */
    submitPages(allocation, renderer) {
        const gl = renderer.getContext();
        // const updateRegion = GPUSplatAllocator.computeTextureUpdateRegion(from, to, textureSize.x, elementsPerTexel, elementsPerSplat);
        // const updateElementCount = updateRegion.dataEnd - updateRegion.dataStart;
        // const updateDataView = new paddedData.constructor(paddedData.buffer,
        //     updateRegion.dataStart * bytesPerElement, updateElementCount);
        // const updateHeight = updateRegion.endRow - updateRegion.startRow + 1;
        const textureProps = renderer.properties.get(this.texture);


        const updateHeight = allocation.endPage - allocation.startPage;
        const currentTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.bindTexture(gl.TEXTURE_2D, textureProps.__webglTexture);
        // three.js leaves the unpack state of the last texture it uploaded (an image texture uploads with FLIP_Y = true),
        // make sure this is a plain copy:
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0, allocation.startPage,
            this.texelsPerPage, updateHeight,
            this.glFormat,
            this.glType,
            allocation.view
        );
        gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    }

    dispose() {
        if (this.texture) {
            this.texture.dispose();
            this.texture = null;
        }
        this._freeAllocs = [];
    }
}

export class SplatStagingBuffer {
    constructor(allocator, splatOffset, splatCount, centersColorsAlloc, covariancesAlloc, scaleRotationsAlloc, shAlloc, sceneIndexesAlloc) {
        this.allocator = allocator;
        // Global splat index (the value used in the splat index buffer) of the first splat of this allocation
        this.splatOffset = splatOffset;
        this.splatCount = splatCount;
        this.centerColorsAllocation = centersColorsAlloc;
        this.covariancesAllocation = covariancesAlloc;
        this.scaleRotationsAllocation = scaleRotationsAlloc;
        this.sphericalHarmonicsAllocation = shAlloc;
        this.sceneIndexesAllocation = sceneIndexesAlloc;
        this.freed = false;
    }

    get centerColorsBuffer() {
        return this.centerColorsAllocation.view;
    }

    get covariancesBuffer() {
        return this.covariancesAllocation ? this.covariancesAllocation.view : undefined;
    }

    get scaleRotationsBuffer() {
        return this.scaleRotationsAllocation ? this.scaleRotationsAllocation.view : undefined;
    }

    get sphericalHarmonicsBuffer() {
        return this.sphericalHarmonicsAllocation ? this.sphericalHarmonicsAllocation.view : undefined;
    }

    get sceneIndexesBuffer() {
        return this.sceneIndexesAllocation.view;
    }

    /**
     * Copies packed node data into the staging views. For changes to apply to the GPU texture, call submit()
     * @param {Object} nodeData
     * @param {number} sceneIndex scene index for this node
     */
    writeNodeData(nodeData, sceneIndex) {
        const count = nodeData.splatCount;
        const elementsPerSplat = SplatDataPacking.getElementsPerSplat(this.allocator.getSplatDataFormat());

        this.centerColorsBuffer.set(nodeData.centerColors.subarray(0, count * elementsPerSplat.centerColors));

        if (this.covariancesAllocation) {
            const covariances = nodeData.covariances.subarray(0, count * elementsPerSplat.covariances);
            this.covariancesBuffer.set(covariances);
        }

        if (this.scaleRotationsAllocation) {
            this.scaleRotationsBuffer.set(nodeData.scaleRotations.subarray(0, count * elementsPerSplat.scaleRotations));
        }

        // TODO: SUPPORT Spherical Harmonics

        this.sceneIndexesBuffer.fill(sceneIndex, 0, count);
    }

    // Finishes all changes and upload them to the GPU
    submit() {
        if (this.freed) {
            console.error(new Error("SplatStagingBuffer::submit: allocation was already freed !!!"));
            return;
        }

        this.allocator.submitSplatAllocation("centerColors", this.centerColorsAllocation);

        // 3D vs 2D:
        if (this.covariancesAllocation) {
            this.allocator.submitSplatAllocation("covariances", this.covariancesAllocation);
        } else if (this.scaleRotationsAllocation) {
            this.allocator.submitSplatAllocation("scaleRotations", this.scaleRotationsAllocation);
        }

        if (this.sphericalHarmonicsAllocation) {
            this.allocator.submitSplatAllocation("sphericalHarmonics", this.sphericalHarmonicsAllocation);
        }

        this.allocator.submitSplatAllocation("sceneIndexes", this.sceneIndexesAllocation);
    }
}

export class GPUSplatAllocator {

    //TODO: Use the preallocated data buffers that have already been created for THREE.DataTextures
    // as staging buffers. Limit the maximum transfer to a fixed number of pages:
    static STAGING_BUFFER_PAGES = 10;

    //TODO: manage all splat texture memory and dynamically allocate and push the texture data after the sorts happen
    static PAGE_TEXEL_SIZE = 4096; //num of texels from a texture that makes up a full page
    static DATA_TEXTURE_SIZE = new THREE.Vector2(4096, 4096)

    constructor(splatRenderMode, halfPrecisionCovariancesOnGPU, shCompressionLevel, logLevel = LogLevel.None) {
        //
        // TODO: Actually dont use this dict-like object, have the textures be members of this class. DO NOT STORE INTERMEDIATE TEXTURE DATA AT ALL
        //
        this.renderer = null;
        this.webGLUtils = null;
        this.material = null;

        this.splatRenderMode = splatRenderMode;
        this.halfPrecisionCovariancesOnGPU = halfPrecisionCovariancesOnGPU;
        this.shCompressionLevel = shCompressionLevel;
        this.logLevel = logLevel;

        // Splat Data textures:
        this.splatTextureDescriptors = {};

        // Compression
        this.covarianceCompressionLevel = halfPrecisionCovariancesOnGPU ? 1 : 0;

        //Scale + Rotations compression is fixed for now 
        this.scaleRotationCompressionLevel = 0;
    }

    /**
     *
     * Textures to manage:
     * -indexes texture (needs to be reworked to just pass an offset per node OR node id rather than the per-splat id),
     * -centers + colors,
     * -covariances
     * -sh
     *
     * "Static" Textures to manage: (these will also have to be updated dynamically but less frequently)
     * -nodeOffsets(make a new nodeIndex to memory offset for the new allocator)
     * -sceneIndexes (Change to Node index to sceneId. Make static)
     *
     * */

    /**
     * Allocates the initial splat textures and binds to the given renderer
     * @param {THREE.WebGLRenderer} renderer
     * @param {SplatMaterial3D | SplatMaterial2D} splatMaterial
     * @param {number} maxSplats
     */
    setup(renderer, splatMaterial, maxSplats) {
        //
        //
        //TODO: just initialize/preallocate the textures but dont upload anything into it yet
        // -prealloc to the 16M Splats...
        //
        //
        this.renderer = renderer;
        this.material = splatMaterial;

        // Setup WebGLUtils
        const gl = this.renderer.getContext();
        const extensions = new WebGLExtensions(gl);
        const capabilities = new WebGLCapabilities(gl, extensions, {});
        extensions.init(capabilities);
        this.webGLUtils = new THREE.WebGLUtils(gl, extensions, capabilities);

        //TODO: redundant, replace this call with the contents
        const computeDataTextureSize = (elementsPerTexel, elementsPerSplat) => {
            return GPUSplatAllocator.DATA_TEXTURE_SIZE;
        };

        //TODO: redundant, replace this call with the contents
        const getCovariancesInitialTextureSpecs = (compressionLevel) => {
            const elementsPerTexelStored = compressionLevel >= 1 ? Constants.COVARIANCES_ELEMENTS_PER_TEXEL_COMPRESSED_STORED : Constants.COVARIANCES_ELEMENTS_PER_TEXEL_STORED;
            const texSize = computeDataTextureSize(elementsPerTexelStored, 6);
            return {elementsPerTexelStored, texSize};
        };

        let covarianceCompressionLevel = this.halfPrecisionCovariancesOnGPU ? 1 : 0;
        const shCompressionLevel = this.shCompressionLevel;

        if (this.splatRenderMode === SplatRenderMode.ThreeD) {
            const initialCovTexSpecs = getCovariancesInitialTextureSpecs(covarianceCompressionLevel);
            if (initialCovTexSpecs.texSize.x * initialCovTexSpecs.texSize.y > Constants.MAX_TEXTURE_TEXELS && covarianceCompressionLevel === 0) {
                // Increase covariance compression in case of overflow:
                covarianceCompressionLevel = 1;
            }
        }
        this.covarianceCompressionLevel = covarianceCompressionLevel;

        // TODO: Add SH support
        // let SphericalHarmonicsArrayType = Float32Array;
        // if (shCompressionLevel === 1) SphericalHarmonicsArrayType = Uint16Array;
        // else if (shCompressionLevel === 2) SphericalHarmonicsArrayType = Uint8Array;
        // const shComponentCount = getSphericalHarmonicsComponentCountForDegree(this.minSphericalHarmonicsDegree);
        // const shData = this.minSphericalHarmonicsDegree ? new SphericalHarmonicsArrayType(maxSplatCount * shComponentCount) : undefined;

        //
        // Pre-allocate all data textures
        //

        const centersColsTexSize = computeDataTextureSize(Constants.CENTER_COLORS_ELEMENTS_PER_TEXEL, 4);
        const paddedCentersCols = new Uint32Array(centersColsTexSize.x * centersColsTexSize.y * Constants.CENTER_COLORS_ELEMENTS_PER_TEXEL);

        // TODO: Remove. Move packing logic elsewhere
        // SplatMesh.updateCenterColorsPaddedData(0, splatCount - 1, centers, colors, paddedCentersCols);

        const centersColorsTexture = new THREE.DataTexture(
            paddedCentersCols,
            centersColsTexSize.x, centersColsTexSize.y,
            THREE.RGBAIntegerFormat,
            THREE.UnsignedIntType
        );
        centersColorsTexture.internalFormat = 'RGBA32UI';
        this.material.uniforms.centersColorsTexture.value = centersColorsTexture;
        this.material.uniforms.centersColorsTextureSize.value.copy(centersColsTexSize);
        this.material.uniformsNeedUpdate = true;

        const centersColorsElementsPerTexel = Constants.CENTER_COLORS_ELEMENTS_PER_TEXEL;
        const centersColorsElementsPerSplat = Constants.CENTER_COLORS_ELEMENTS_PER_SPLAT;
        const centersColorsBytesPerElement = 4;

        // initTexture() only creates the GL texture if the texture is marked for update (version > 0).
        centersColorsTexture.needsUpdate = true;
        this.renderer.initTexture(centersColorsTexture);
        this.splatTextureDescriptors = {
            'centerColors': {
                'texture': new PagedTexture(centersColorsTexture, this.webGLUtils, centersColorsElementsPerTexel, centersColorsBytesPerElement),
                'compressionLevel': 0,
                'elementsPerTexel': centersColorsElementsPerTexel,
                'elementsPerSplat': centersColorsElementsPerSplat,
                'texelsPerSplat': centersColorsElementsPerSplat / centersColorsElementsPerTexel,
                'bytesPerElement': centersColorsBytesPerElement,
            }
        };

        if (this.splatRenderMode === SplatRenderMode.ThreeD) {
            //
            // Fort 3D splats we setup covariances data texture:
            //

            const covTexSpecs = getCovariancesInitialTextureSpecs(covarianceCompressionLevel);
            const covariancesElementsPerTexelStored = covTexSpecs.elementsPerTexelStored;
            const covTexSize = covTexSpecs.texSize;

            let CovariancesDataType = covarianceCompressionLevel >= 1 ? Uint32Array : Float32Array;
            const covariancesElementsPerTexelAllocated =
                covarianceCompressionLevel >= 1 ? Constants.COVARIANCES_ELEMENTS_PER_TEXEL_COMPRESSED_ALLOCATED
                    : Constants.COVARIANCES_ELEMENTS_PER_TEXEL_ALLOCATED;
            const covariancesArrayElementsPerTexel = covarianceCompressionLevel >= 1 ? 4 : covariancesElementsPerTexelAllocated;
            const covariancesTextureData = new CovariancesDataType(covTexSize.x * covTexSize.y * covariancesArrayElementsPerTexel);

            // TODO: Remove. Move packing logic elsewhere
            // if (covarianceCompressionLevel === 0) {
            //     covariancesTextureData.set(covariances);
            // } else {
            //     SplatMesh.updatePaddedCompressedCovariancesTextureData(covariances, covariancesTextureData, 0, 0, covariances.length);
            // }

            let covariancesTexture;
            if (covarianceCompressionLevel >= 1) {
                covariancesTexture = new THREE.DataTexture(
                    covariancesTextureData,
                    covTexSize.x, covTexSize.y,
                    THREE.RGBAIntegerFormat,
                    THREE.UnsignedIntType
                );
                covariancesTexture.internalFormat = 'RGBA32UI';
                this.material.uniforms.covariancesTextureHalfFloat.value = covariancesTexture;
            } else {
                covariancesTexture = new THREE.DataTexture(
                    covariancesTextureData,
                    covTexSize.x, covTexSize.y,
                    THREE.RGBAFormat,
                    THREE.FloatType
                );
                this.material.uniforms.covariancesTexture.value = covariancesTexture;

                // For some reason a usampler2D needs to have a valid texture attached or WebGL complains
                const dummyTex = new THREE.DataTexture(
                    new Uint32Array(32),
                    2, 2,
                    THREE.RGBAIntegerFormat,
                    THREE.UnsignedIntType
                );
                dummyTex.internalFormat = 'RGBA32UI';
                this.material.uniforms.covariancesTextureHalfFloat.value = dummyTex;
                dummyTex.needsUpdate = true;
            }

            this.material.uniforms.covariancesAreHalfFloat.value = (covarianceCompressionLevel >= 1) ? 1 : 0;
            this.material.uniforms.covariancesTextureSize.value.copy(covTexSize);

            const covarianceElementsPerTexel = (covarianceCompressionLevel === 0) ? covariancesElementsPerTexelStored : covariancesElementsPerTexelAllocated;
            const covarianceElementsPerSplat = (covarianceCompressionLevel === 0) ? Constants.COVARIANCES_ELEMENTS_PER_SPLAT : covariancesElementsPerTexelAllocated;
            const covarianceBytesPerElement = (covarianceCompressionLevel === 0) ? 4 : 2;

            covariancesTexture.needsUpdate = true;
            this.renderer.initTexture(covariancesTexture);
            this.splatTextureDescriptors['covariances'] = {
                'texture': new PagedTexture(covariancesTexture, this.webGLUtils, covarianceElementsPerTexel, covarianceBytesPerElement),
                'compressionLevel': covarianceCompressionLevel,
                'elementsPerTexel': covarianceElementsPerTexel,
                'elementsPerSplat': covarianceElementsPerSplat,
                'texelsPerSplat': covarianceElementsPerSplat / covarianceElementsPerTexel,
                'bytesPerElement': covarianceBytesPerElement,
            }
        } else {
            //
            // For 2D splats we setup scale + rotations data texture:
            //
            const scaleRotationElementsPerSplat = 6;
            const scaleRotationsTexSize = computeDataTextureSize(Constants.SCALES_ROTATIONS_ELEMENTS_PER_TEXEL, scaleRotationElementsPerSplat);
            let ScaleRotationsDataType = this.scaleRotationCompressionLevel >= 1 ? Uint16Array : Float32Array;
            let scaleRotationsTextureType = this.scaleRotationCompressionLevel >= 1 ? THREE.HalfFloatType : THREE.FloatType;
            const paddedScaleRotations = new ScaleRotationsDataType(scaleRotationsTexSize.x * scaleRotationsTexSize.y * Constants.SCALES_ROTATIONS_ELEMENTS_PER_TEXEL);

            // TODO: Remove. Move packing logic elsewhere
            // SplatMesh.updateScaleRotationsPaddedData(0, splatCount - 1, scales, rotations, paddedScaleRotations);

            const scaleRotationsTexture = new THREE.DataTexture(
                paddedScaleRotations,
                scaleRotationsTexSize.x, scaleRotationsTexSize.y,
                THREE.RGBAFormat,
                scaleRotationsTextureType
            );

            this.material.uniforms.scaleRotationsTexture.value = scaleRotationsTexture;
            this.material.uniforms.scaleRotationsTextureSize.value.copy(scaleRotationsTexSize);

            const scaleRotationElementsPerTexel = Constants.SCALES_ROTATIONS_ELEMENTS_PER_TEXEL;
            const scaleRotationBytesPerElement = this.scaleRotationCompressionLevel === 0 ? 4 : 2

            scaleRotationsTexture.needsUpdate = true;
            this.renderer.initTexture(scaleRotationsTexture);
            this.splatTextureDescriptors['scaleRotations'] = {
                'texture': new PagedTexture(scaleRotationsTexture, this.webGLUtils, scaleRotationElementsPerTexel, scaleRotationBytesPerElement),
                'compressionLevel': this.scaleRotationCompressionLevel,
                'elementsPerTexel': scaleRotationElementsPerTexel,
                'elementsPerSplat': scaleRotationElementsPerSplat,
                'texelsPerSplat': scaleRotationElementsPerSplat / scaleRotationElementsPerTexel,
                'bytesPerElement': scaleRotationBytesPerElement,
            };
        }

        // TODO: Add SH support
        // if (shData) {
        //     const shTextureType = shCompressionLevel === 2 ? THREE.UnsignedByteType : THREE.HalfFloatType;
        //
        //     let paddedSHComponentCount = shComponentCount;
        //     if (paddedSHComponentCount % 2 !== 0) paddedSHComponentCount++;
        //     const shElementsPerTexel = 4;
        //     const texelFormat = shElementsPerTexel === 4 ? THREE.RGBAFormat : THREE.RGFormat;
        //     let shTexSize = computeDataTextureSize(shElementsPerTexel, paddedSHComponentCount);
        //
        //     // Use one texture for all spherical harmonics data
        //     if (shTexSize.x * shTexSize.y <= Constants.MAX_TEXTURE_TEXELS) {
        //         const paddedSHArraySize = shTexSize.x * shTexSize.y * shElementsPerTexel;
        //         const paddedSHArray = new SphericalHarmonicsArrayType(paddedSHArraySize);
        //         for (let c = 0; c < splatCount; c++) {
        //             const srcBase = shComponentCount * c;
        //             const destBase = paddedSHComponentCount * c;
        //             for (let i = 0; i < shComponentCount; i++) {
        //                 paddedSHArray[destBase + i] = shData[srcBase + i];
        //             }
        //         }
        //
        //         const shTexture = new THREE.DataTexture(paddedSHArray, shTexSize.x, shTexSize.y, texelFormat, shTextureType);
        //         shTexture.needsUpdate = true;
        //         this.material.uniforms.sphericalHarmonicsTexture.value = shTexture;
        //         this.splatDataTextures['sphericalHarmonics'] = {
        //             'componentCount': shComponentCount,
        //             'paddedComponentCount': paddedSHComponentCount,
        //             'data': paddedSHArray,
        //             'textureCount': 1,
        //             'texture': shTexture,
        //             'size': shTexSize,
        //             'compressionLevel': shCompressionLevel,
        //             'elementsPerTexel': shElementsPerTexel
        //         };
        //         // Use three textures for spherical harmonics data, one per color channel
        //     } else {
        //         const shComponentCountPerChannel = shComponentCount / 3;
        //         paddedSHComponentCount = shComponentCountPerChannel;
        //         if (paddedSHComponentCount % 2 !== 0) paddedSHComponentCount++;
        //         shTexSize = computeDataTextureSize(shElementsPerTexel, paddedSHComponentCount);
        //
        //         const paddedSHArraySize = shTexSize.x * shTexSize.y * shElementsPerTexel;
        //         const textureUniforms = [this.material.uniforms.sphericalHarmonicsTextureR,
        //             this.material.uniforms.sphericalHarmonicsTextureG,
        //             this.material.uniforms.sphericalHarmonicsTextureB];
        //         const paddedSHArrays = [];
        //         const shTextures = [];
        //         for (let t = 0; t < 3; t++) {
        //             const paddedSHArray = new SphericalHarmonicsArrayType(paddedSHArraySize);
        //             paddedSHArrays.push(paddedSHArray);
        //             for (let c = 0; c < splatCount; c++) {
        //                 const srcBase = shComponentCount * c;
        //                 const destBase = paddedSHComponentCount * c;
        //                 if (shComponentCountPerChannel >= 3) {
        //                     for (let i = 0; i < 3; i++) paddedSHArray[destBase + i] = shData[srcBase + t * 3 + i];
        //                     if (shComponentCountPerChannel >= 8) {
        //                         for (let i = 0; i < 5; i++) paddedSHArray[destBase + 3 + i] = shData[srcBase + 9 + t * 5 + i];
        //                     }
        //                 }
        //             }
        //
        //             const shTexture = new THREE.DataTexture(paddedSHArray, shTexSize.x, shTexSize.y, texelFormat, shTextureType);
        //             shTextures.push(shTexture);
        //             shTexture.needsUpdate = true;
        //             textureUniforms[t].value = shTexture;
        //         }
        //
        //         this.material.uniforms.sphericalHarmonicsMultiTextureMode.value = 1;
        //         this.splatDataTextures['sphericalHarmonics'] = {
        //             'componentCount': shComponentCount,
        //             'componentCountPerChannel': shComponentCountPerChannel,
        //             'paddedComponentCount': paddedSHComponentCount,
        //             'data': paddedSHArrays,
        //             'textureCount': 3,
        //             'textures': shTextures,
        //             'size': shTexSize,
        //             'compressionLevel': shCompressionLevel,
        //             'elementsPerTexel': shElementsPerTexel
        //         };
        //     }
        //
        //     this.material.uniforms.sphericalHarmonicsTextureSize.value.copy(shTexSize);
        //     this.material.uniforms.sphericalHarmonics8BitMode.value = shCompressionLevel === 2 ? 1 : 0;
        //     for (let s = 0; s < this.scenes.length; s++) {
        //         const splatBuffer = this.scenes[s].splatBuffer;
        //         this.material.uniforms.sphericalHarmonics8BitCompressionRangeMin.value[s] =
        //             splatBuffer.minSphericalHarmonicsCoeff;
        //         this.material.uniforms.sphericalHarmonics8BitCompressionRangeMax.value[s] =
        //             splatBuffer.maxSphericalHarmonicsCoeff;
        //     }
        //     this.material.uniformsNeedUpdate = true;
        // }

        // TODO:  use maxSplats to calculate the sceneIndexesTexSize
        const sceneIndexesTexSize = new THREE.Vector2(4096, 1024)
        const paddedTransformIndexes = new Uint32Array(sceneIndexesTexSize.x * sceneIndexesTexSize.y * Constants.SCENE_INDEXES_ELEMENTS_PER_TEXEL);

        // TODO: Remove. Move packing logic elsewhere
        // for (let c = 0; c < splatCount; c++) paddedTransformIndexes[c] = this.globalSplatIndexToSceneIndexMap[c];

        const sceneIndexesTexture = new THREE.DataTexture(
            paddedTransformIndexes,
            sceneIndexesTexSize.x, sceneIndexesTexSize.y,
            THREE.RedIntegerFormat,
            THREE.UnsignedIntType
        );
        sceneIndexesTexture.internalFormat = 'R32UI';
        this.material.uniforms.sceneIndexesTexture.value = sceneIndexesTexture;
        this.material.uniforms.sceneIndexesTextureSize.value.copy(sceneIndexesTexSize);
        this.material.uniformsNeedUpdate = true;

        const sceneIndexesElementsPerTexel = Constants.SCENE_INDEXES_ELEMENTS_PER_TEXEL;
        const sceneIndexesElementsPerSplat = 1; // 4 TODO: THIS IS WRONG PROBABLY -> should be 1
        const sceneIndexesBytesPerElement = 4;

        // initTexture() only creates the GL texture if the texture is marked for update (version > 0).
        sceneIndexesTexture.needsUpdate = true;
        this.renderer.initTexture(sceneIndexesTexture);
        this.splatTextureDescriptors['sceneIndexes'] = {
            'texture': new PagedTexture(sceneIndexesTexture, this.webGLUtils, sceneIndexesElementsPerTexel, sceneIndexesBytesPerElement),
            'compressionLevel': 0,
            'elementsPerTexel': sceneIndexesElementsPerTexel,
            'elementsPerSplat': sceneIndexesElementsPerSplat,
            'texelsPerSplat': 1,
            'bytesPerElement': sceneIndexesBytesPerElement,
        };

        //TODO: Update Scene count dynamically instead of only here:
        this.setSceneCount(0);

        this.splatAllocationGranularity = this.computeSplatAllocationGranularity();
        if (this.logLevel >= LogLevel.Info) {
            console.log(`GPUSplatAllocator: allocation granularity ${this.splatAllocationGranularity} splats`);
        }
    }

    disposeTextures() {
        for (let textureKey in this.splatTextureDescriptors) {
            if (this.splatTextureDescriptors.hasOwnProperty(textureKey)) {
                const textureContainer = this.splatTextureDescriptors[textureKey];
                if (textureContainer.texture) {
                    textureContainer.texture.dispose();
                    textureContainer.texture = null;
                }
            }
        }
        this.splatTextureDescriptors = null;
    }

    /**
     * The GPU layout that data written into a SplatStagingBuffer must have.
     * Pass this to VirtualSplatBuffer.getSplatNodeData().
     * @return {SplatDataFormat}
     */
    getSplatDataFormat() {
        return {
            splatRenderMode: this.splatRenderMode,
            covarianceCompressionLevel: this.covarianceCompressionLevel,
            scaleRotationCompressionLevel: this.scaleRotationCompressionLevel
        };
    }

    /**
     * @param {number} sceneCount number of scenes that write into the scene indexes texture. The shader only reads
     *                            the scene indexes texture when there is more than one scene.
     */
    setSceneCount(sceneCount) {
        this.material.uniforms.sceneCount.value = sceneCount;
        this.material.uniformsNeedUpdate = true;
    }

    /**
     * All textures are paged independently but are addressed with the same splat index in the shaders, so every
     * allocation must start at the same splat index in every texture. That holds as long as every allocation is a
     * whole number of pages in every texture. This returns the smallest splat count with that property: one page
     * (4096 splats) when every texture stores a whole number of texels per splat, 8192 splats when uncompressed
     * covariances / 2D scale-rotations are used (1.5 texels per splat: 8192 splats = 2 + 3 pages).
     * @return {number}
     */
    computeSplatAllocationGranularity() {
        const centerColorsDesc = this.splatTextureDescriptors['centerColors'];
        const splatsPerCenterPage = centerColorsDesc.texture.texelsPerPage / centerColorsDesc.texelsPerSplat;
        let granularity = splatsPerCenterPage;
        const isWholePages = (splats) => {
            for (const name in this.splatTextureDescriptors) {
                const desc = this.splatTextureDescriptors[name];
                const texels = splats * desc.texelsPerSplat;
                if (!Number.isInteger(texels) || texels % desc.texture.texelsPerPage !== 0) return false;
            }
            return true;
        };
        while (!isWholePages(granularity)) {
            granularity += splatsPerCenterPage;
            if (granularity > splatsPerCenterPage * 64) {
                throw new Error('GPUSplatAllocator: could not find a common allocation granularity for the data textures');
            }
        }
        return granularity;
    }

    /**
     * First splat index covered by an allocation of the given texture.
     * @param {Object} textureDesc
     * @param {Object} allocation
     * @return {number} may be fractional if the allocation does not start on a splat boundary
     */
    static getAllocationSplatOffset(textureDesc, allocation) {
        return textureDesc.texture.getAllocationStartTexel(allocation) / textureDesc.texelsPerSplat;
    }

    /**
     * Allocates the given number of splats
     * @param {number} numSplats
     * @return {SplatStagingBuffer | null} the staging buffer for transferring memory to GPU or null if OOM
     */
    allocate(numSplats) {
        if (!(numSplats > 0)) throw new Error(`GPUSplatAllocator::allocate() -> invalid splat count ${numSplats}`);

        const centerColorsTextureDes = this.splatTextureDescriptors['centerColors'];
        const covarancesTextureDesc = this.splatTextureDescriptors['covariances'];
        const scaleRotationsTextureDesc = this.splatTextureDescriptors['scaleRotations'];
        const sphericalHarmonicsDesc = this.splatTextureDescriptors['sphericalHarmonics'];
        const sceneIndexesDesc = this.splatTextureDescriptors['sceneIndexes'];

        // Round up so that the allocation is a whole number of pages in every texture (keeps all textures aligned)
        // TODO: THIS DOES WASTE A LOT OF MEMORY. CALCULATE THE OFFSETS IN SHADERS. 
        //  ALL WE NEED IS TO KEEP THE PAGES IN THE SAME ORDER BETWEEN TEXTURES
        const granularity = this.splatAllocationGranularity;
        const numAllocatedSplats = Math.ceil(numSplats / granularity) * granularity;

        // Collect allocation so that it can be returned to its texture if any of the others fail
        const allocations = [];
        const allocateFrom = (desc) => {
            const alloc = desc.texture.allocatePages(desc.texelsPerSplat * numAllocatedSplats);
            if (alloc) allocations.push({ desc, alloc });
            return alloc;
        };
        const rollback = () => {
            for (const { desc, alloc } of allocations) {
                desc.texture.freePages([alloc]);
            }
        };

        const centersColorsAlloc = allocateFrom(centerColorsTextureDes);

        let covariancesAlloc = undefined;
        let scaleRotAlloc = undefined;
        if (covarancesTextureDesc) {
            covariancesAlloc = allocateFrom(covarancesTextureDesc);
        } else if (scaleRotationsTextureDesc) {
            scaleRotAlloc = allocateFrom(scaleRotationsTextureDesc);
        }

        let shAlloc = undefined;
        if (sphericalHarmonicsDesc) {
            shAlloc = allocateFrom(sphericalHarmonicsDesc);
        }

        const sceneIndexesAlloc = allocateFrom(sceneIndexesDesc);

        if (centersColorsAlloc === null || covariancesAlloc === null || scaleRotAlloc === null || shAlloc === null || sceneIndexesAlloc === null) {
            console.error("GPUSplatAllocator ERROR: OOM")
            rollback();
            return null;
        }

        // DEBUG: the shaders address every texture with the same splat index, so all allocations must start at
        // the same splat index. Rounding to splatAllocationGranularity guarantees this as long as every texture
        // page is synced (breaks if one texture runs out of pages and falls back to its free list first).
        // TODO: FIX AND REMOVE THIS
        const splatOffset = GPUSplatAllocator.getAllocationSplatOffset(centerColorsTextureDes, centersColorsAlloc);
        for (const { desc, alloc } of allocations) {
            const offset = GPUSplatAllocator.getAllocationSplatOffset(desc, alloc);
            if (offset !== splatOffset) {
                console.error(`GPUSplatAllocator ERROR: misaligned allocation, splat offset ${offset} in one texture vs ${splatOffset} in the centers/colors texture`);
                rollback();
                return null;
            }
        }

        return new SplatStagingBuffer(this, splatOffset, numSplats, centersColorsAlloc, covariancesAlloc, scaleRotAlloc, shAlloc, sceneIndexesAlloc);
    }

    /**
     * Returns the allocations from the given SplatStagingBuffer to their textures.
     * @param {SplatStagingBuffer} stagingBuffer
     */
    free(stagingBuffer) {
        if (!stagingBuffer || stagingBuffer.freed) return;
        const freeAlloc = (name, allocation) => {
            if (allocation) this.splatTextureDescriptors[name].texture.freePages([allocation]);
        };
        freeAlloc('centerColors', stagingBuffer.centerColorsAllocation);
        freeAlloc('covariances', stagingBuffer.covariancesAllocation);
        freeAlloc('scaleRotations', stagingBuffer.scaleRotationsAllocation);
        freeAlloc('sphericalHarmonics', stagingBuffer.sphericalHarmonicsAllocation);
        freeAlloc('sceneIndexes', stagingBuffer.sceneIndexesAllocation);
        stagingBuffer.freed = true;
    }

    /**
     * Uploads an allocation of the given texture to the GPU
     * @param {string} textureName
     * @param {Object} allocation
     */
    submitSplatAllocation(textureName, allocation) {
        this.splatTextureDescriptors[textureName].texture.submitPages(allocation, this.renderer);
    }

    // updateDataTexturesFromBaseData(fromSplat, toSplat) {
    //     const centerColorsTextureDescriptor = this.splatTextureDescriptors['centerColors'];
    //     const covarancesTextureDesc = this.splatTextureDescriptors['covariances'];
    //     const covarianceCompressionLevel = covarancesTextureDesc ? covarancesTextureDesc.compressionLevel : undefined;
    //     const scaleRotationsTextureDesc = this.splatTextureDescriptors['scaleRotations'];
    //     // const shTextureDesc = this.splatTextureDescriptors['sphericalHarmonics'];
    //     // const shCompressionLevel = shTextureDesc ? shTextureDesc.compressionLevel : 0;
    //
    //     // Update center & color data texture
    //
    //     //TODO: Do the Data packing elsewhere before calling this
    //
    //     // const paddedCenterColors = centerColorsTextureDescriptor.data;
    //     // SplatMesh.updateCenterColorsPaddedData(fromSplat, toSplat, this.splatDataTextures.baseData.centers,
    //     //     this.splatDataTextures.baseData.colors, paddedCenterColors);
    //
    //     const centerColorsTexture = centerColorsTextureDescriptor.texture;
    //     const centerColorsTextureProps = this.renderer ? this.renderer.properties.get(centerColorsTexture) : null;
    //     if (!centerColorsTextureProps || !centerColorsTextureProps.__webglTexture) {
    //         centerColorsTexture.needsUpdate = true;
    //     } else {
    //         this.updateDataTexture(paddedCenterColors, centerColorsTextureDescriptor.texture, centerColorsTextureDescriptor.size,
    //             centerColorsTextureProps, centerColorsTextureDescriptor.elementsPerTexel, centerColorsTextureDescriptor.elementsPerSplat,
    //             centerColorsTextureDescriptor.bytesPerElement, fromSplat, toSplat);
    //     }
    //
    //     // update covariance data texture
    //     if (covarancesTextureDesc) {
    //         performance.mark("Covariance-texture-upload-started")
    //         const covariancesTexture = covarancesTextureDesc.texture;
    //
    //         //TODO: Do the Data packing elsewhere before calling this
    //
    //         // const covarancesStartElement = fromSplat * Constants.COVARIANCES_ELEMENTS_PER_SPLAT;
    //         // const covariancesEndElement = toSplat * Constants.COVARIANCES_ELEMENTS_PER_SPLAT;
    //         // if (covarianceCompressionLevel === 0) {
    //         //     for (let i = covarancesStartElement; i <= covariancesEndElement; i++) {
    //         //         covarancesTextureDesc.data[i] = this.splatDataTextures.baseData.covariances[i];
    //         //     }
    //         // } else {
    //         //     SplatMesh.updatePaddedCompressedCovariancesTextureData(this.splatDataTextures.baseData.covariances,
    //         //         covarancesTextureDesc.data,
    //         //         fromSplat * covarancesTextureDesc.elementsPerTexelAllocated,
    //         //         covarancesStartElement, covariancesEndElement);
    //         // }
    //
    //         const covariancesTextureProps = this.renderer ? this.renderer.properties.get(covariancesTexture) : null;
    //         if (!covariancesTextureProps || !covariancesTextureProps.__webglTexture) {
    //             covariancesTexture.needsUpdate = true;
    //         } else {
    //             this.updateDataTexture(covarancesTextureDesc.data, covarancesTextureDesc.texture, covarancesTextureDesc.size,
    //                 covariancesTextureProps, covarancesTextureDesc.elementsPerTexel, covarancesTextureDesc.elementsPerSplat,
    //                 covarancesTextureDesc.bytesPerElement, fromSplat, toSplat);
    //         }
    //
    //         performance.mark("Covariance-texture-upload-ended")
    //         const measure = performance.measure("covariance texture upload", "Covariance-texture-upload-started", "Covariance-texture-upload-ended")
    //         if (this.logLevel === LogLevel.Info)
    //             console.log("Covariance texture update time", measure.duration);
    //     }
    //
    //     // update scale and rotation data texture
    //     if (scaleRotationsTextureDesc) {
    //         const paddedScaleRotations = scaleRotationsTextureDesc.data;
    //         const scaleRotationsTexture = scaleRotationsTextureDesc.texture;
    //
    //         //TODO: Do the Data packing elsewhere before calling this
    //
    //         // SplatMesh.updateScaleRotationsPaddedData(fromSplat, toSplat, this.splatDataTextures.baseData.scales,
    //         //     this.splatDataTextures.baseData.rotations, paddedScaleRotations);
    //
    //         const scaleRotationsTextureProps = this.renderer ? this.renderer.properties.get(scaleRotationsTexture) : null;
    //         if (!scaleRotationsTextureProps || !scaleRotationsTextureProps.__webglTexture) {
    //             scaleRotationsTexture.needsUpdate = true;
    //         } else {
    //             this.updateDataTexture(paddedScaleRotations, scaleRotationsTextureDesc.texture, scaleRotationsTextureDesc.size,
    //                 scaleRotationsTextureProps, scaleRotationsTextureDesc.elementsPerTexel, scaleRotationsTextureDesc.elementsPerSplat,
    //                 scaleRotationsTextureDesc.bytesPerElement, fromSplat, toSplat);
    //         }
    //     }
    //     //
    //     // // update spherical harmonics data texture
    //     // const shData = this.splatDataTextures.baseData.sphericalHarmonics;
    //     // if (shData) {
    //     //     let shBytesPerElement = 4;
    //     //     if (shCompressionLevel === 1) shBytesPerElement = 2;
    //     //     else if (shCompressionLevel === 2) shBytesPerElement = 1;
    //     //
    //     //     const updateTexture = (shTexture, shTextureSize, elementsPerTexel, paddedSHArray, paddedSHComponentCount) => {
    //     //         const shTextureProps = this.renderer ? this.renderer.properties.get(shTexture) : null;
    //     //         if (!shTextureProps || !shTextureProps.__webglTexture) {
    //     //             shTexture.needsUpdate = true;
    //     //         } else {
    //     //             this.updateDataTexture(paddedSHArray, shTexture, shTextureSize, shTextureProps, elementsPerTexel,
    //     //                 paddedSHComponentCount, shBytesPerElement, fromSplat, toSplat);
    //     //         }
    //     //     };
    //     //
    //     //     const shComponentCount = shTextureDesc.componentCount;
    //     //     const paddedSHComponentCount = shTextureDesc.paddedComponentCount;
    //     //
    //     //     // Update for the case of a single texture for all spherical harmonics data
    //     //     if (shTextureDesc.textureCount === 1) {
    //     //         const paddedSHArray = shTextureDesc.data;
    //     //         for (let c = fromSplat; c <= toSplat; c++) {
    //     //             const srcBase = shComponentCount * c;
    //     //             const destBase = paddedSHComponentCount * c;
    //     //             for (let i = 0; i < shComponentCount; i++) {
    //     //                 paddedSHArray[destBase + i] = shData[srcBase + i];
    //     //             }
    //     //         }
    //     //         updateTexture(shTextureDesc.texture, shTextureDesc.size,
    //     //             shTextureDesc.elementsPerTexel, paddedSHArray, paddedSHComponentCount);
    //     //         // Update for the case of spherical harmonics data split among three textures, one for each color channel
    //     //     } else {
    //     //         const shComponentCountPerChannel = shTextureDesc.componentCountPerChannel;
    //     //         for (let t = 0; t < 3; t++) {
    //     //             const paddedSHArray = shTextureDesc.data[t];
    //     //             for (let c = fromSplat; c <= toSplat; c++) {
    //     //                 const srcBase = shComponentCount * c;
    //     //                 const destBase = paddedSHComponentCount * c;
    //     //                 if (shComponentCountPerChannel >= 3) {
    //     //                     for (let i = 0; i < 3; i++) paddedSHArray[destBase + i] = shData[srcBase + t * 3 + i];
    //     //                     if (shComponentCountPerChannel >= 8) {
    //     //                         for (let i = 0; i < 5; i++) paddedSHArray[destBase + 3 + i] = shData[srcBase + 9 + t * 5 + i];
    //     //                     }
    //     //                 }
    //     //             }
    //     //             updateTexture(shTextureDesc.textures[t], shTextureDesc.size,
    //     //                 shTextureDesc.elementsPerTexel, paddedSHArray, paddedSHComponentCount);
    //     //         }
    //     //     }
    //     // }
    //
    //     // update scene index & transform data
    //     const sceneIndexesTexDesc = this.splatDataTextures['sceneIndexes'];
    //     const paddedSceneIndexes = sceneIndexesTexDesc.data;
    //     for (let c = fromSplat; c <= toSplat; c++) {
    //         paddedSceneIndexes[c] = this.globalSplatIndexToSceneIndexMap[c];
    //     }
    //     const sceneIndexesTexture = sceneIndexesTexDesc.texture;
    //     const sceneIndexesTextureProps = this.renderer ? this.renderer.properties.get(sceneIndexesTexture) : null;
    //     if (!sceneIndexesTextureProps || !sceneIndexesTextureProps.__webglTexture) {
    //         sceneIndexesTexture.needsUpdate = true;
    //     } else {
    //         this.updateDataTexture(paddedSceneIndexes, sceneIndexesTexDesc.texture, sceneIndexesTexDesc.size,
    //             sceneIndexesTextureProps, 1, 1, 1, this.lastBuildSplatCount, toSplat);
    //     }
    // }
}