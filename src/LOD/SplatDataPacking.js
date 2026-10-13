import { uintEncodedFloat, rgbaArrayToInteger } from '../Util.js';
import { Constants } from '../Constants.js';
import { SplatRenderMode } from '../SplatRenderMode.js';



/**
 * SplatDataPacking: converts decoded per-splat attributes into the exact element layout of the GPU data textures.
 * The layouts are identical to the ones produced by SplatMesh (see SplatMesh.updateCenterColorsPaddedData,
 * SplatMesh.updatePaddedCompressedCovariancesTextureData and SplatMesh.updateScaleRotationsPaddedData), so the same
 * shaders (SplatMaterial3D / SplatMaterial2D) can read them. Splat i of a packed array always starts at element
 * i * elementsPerSplat, which means a packed array can be copied as-is into a SplatStagingBuffer view.
 */

/**
 * @typedef {Object} SplatDataFormat
 * @property {SplatRenderMode} splatRenderMode                 
 * @property {number} covarianceCompressionLevel
 * @property {number} scaleRotationCompressionLevel
 */

export class SplatDataPacking {

    /**
     * Number of elements per splat in the packed arrays (and in the staging buffer views).
     * @param {SplatDataFormat} format
     */
    static getElementsPerSplat(format) {
        return {
            centerColors: Constants.CENTER_COLORS_ELEMENTS_PER_SPLAT,
            covariances: format.covarianceCompressionLevel >= 1 ? 4 : Constants.COVARIANCES_ELEMENTS_PER_SPLAT,
            scaleRotations: 6
        };
    }

    /**
     * @param {Float32Array} centers 
     * @param {Uint8Array} colors
     * @param {number} splatCount
     * @param {Uint32Array} [out]
     * @return {Uint32Array}
     */
    static packCenterColors(centers, colors, splatCount, out) {
        out = out || new Uint32Array(splatCount * 4);
        for (let i = 0; i < splatCount; i++) {
            const c3 = i * 3;
            const c4 = i * 4;
            out[c4] = rgbaArrayToInteger(colors, c4);
            out[c4 + 1] = uintEncodedFloat(centers[c3]);
            out[c4 + 2] = uintEncodedFloat(centers[c3 + 1]);
            out[c4 + 3] = uintEncodedFloat(centers[c3 + 2]);
        }
        return out;
    }

    /**
     * Packs 6 half float covariance components per splat (as produced by SplatBuffer.fillSplatCovarianceArray with
     * desiredOutputCompressionLevel = 1) into one RGBA32UI texel per splat.
     * @param {Uint16Array} halfCovariances
     * @param {number} splatCount
     * @param {Uint32Array} [out]
     * @return {Uint32Array}
     */
    static packHalfCovariances(halfCovariances, splatCount, out) {
        out = out || new Uint32Array(splatCount * 4);
        for (let i = 0; i < splatCount; i++) {
            const s = i * 6;
            const o = i * 4;
            out[o] = (halfCovariances[s] | (halfCovariances[s + 1] << 16)) >>> 0;
            out[o + 1] = (halfCovariances[s + 2] | (halfCovariances[s + 3] << 16)) >>> 0;
            out[o + 2] = (halfCovariances[s + 4] | (halfCovariances[s + 5] << 16)) >>> 0;
            out[o + 3] = 0;
        }
        return out;
    }

    /**
     * Same layout as SplatMesh.updateScaleRotationsPaddedData.
     * @param {Float32Array} scales 3 floats per splat
     * @param {Float32Array} rotations 4 floats per splat
     * @param {number} splatCount
     * @param {Float32Array} [out]
     * @return {Float32Array}
     */
    static packScaleRotations(scales, rotations, splatCount, out) {
        out = out || new Float32Array(splatCount * 6);
        for (let i = 0; i < splatCount; i++) {
            const s3 = i * 3;
            const r4 = i * 4;
            const o = i * 6;
            out[o] = scales[s3];
            out[o + 1] = scales[s3 + 1];
            out[o + 2] = scales[s3 + 2];
            out[o + 3] = rotations[r4];
            out[o + 4] = rotations[r4 + 1];
            out[o + 5] = rotations[r4 + 2];
        }
        return out;
    }

    /**
     * Decodes and packs a range of splats from a SplatBuffer into the correct GPU format.
     * Scene transforms are NOT applied: the DynamicSplatMesh always renders in dynamic mode, where the
     * transform of each scene is applied in the vertex shader.
     * 
     *  TODO: DATA MUST ALREADY COME THIS WAY FROM THE SplatBuffer
     *      
     * @param {SplatBuffer} splatBuffer
     * @param {number} srcFrom first splat (inclusive), index local to the splat buffer
     * @param {number} srcTo last splat (inclusive), index local to the splat buffer
     * @param {SplatDataFormat} format
     * @param {number} minimumAlpha splats with an alpha below this value get alpha = 0
     * @return {{splatCount:number, centers:Float32Array, centerColors:Uint32Array,
     *           covariances:(Float32Array|Uint32Array|undefined), scaleRotations:(Float32Array|undefined)}}
     */
    static packFromSplatBuffer(splatBuffer, srcFrom, srcTo, format, minimumAlpha = 1) {
        const splatCount = srcTo - srcFrom + 1;

        const centers = new Float32Array(splatCount * 3);
        const colors = new Uint8Array(splatCount * 4);
        splatBuffer.fillSplatCenterArray(centers, undefined, srcFrom, srcTo, 0);
        splatBuffer.fillSplatColorArray(colors, minimumAlpha, srcFrom, srcTo, 0);
        const centerColors = SplatDataPacking.packCenterColors(centers, colors, splatCount);

        let covariances;
        let scaleRotations;
        if (format.splatRenderMode === SplatRenderMode.ThreeD) {
            if (format.covarianceCompressionLevel >= 1) {
                const halfCovariances = new Uint16Array(splatCount * 6);
                splatBuffer.fillSplatCovarianceArray(halfCovariances, undefined, srcFrom, srcTo, 0, 1);
                covariances = SplatDataPacking.packHalfCovariances(halfCovariances, splatCount);
            } else {
                // Level 0: the tightly packed float array IS the texture layout
                covariances = new Float32Array(splatCount * 6);
                splatBuffer.fillSplatCovarianceArray(covariances, undefined, srcFrom, srcTo, 0, 0);
            }
        } else {
            if (format.scaleRotationCompressionLevel !== 0) {
                console.error('SplatDataPacking::packFromSplatBuffer: only scaleRotationCompressionLevel 0 is supported');
                return null;
            }
            const scales = new Float32Array(splatCount * 3);
            const rotations = new Float32Array(splatCount * 4);
            const scaleOverride = { x: undefined, y: undefined, z: 1 };
            splatBuffer.fillSplatScaleRotationArray(scales, rotations, undefined, srcFrom, srcTo, 0, 0, scaleOverride);
            scaleRotations = SplatDataPacking.packScaleRotations(scales, rotations, splatCount);
        }

        return {
            splatCount,
            centers, //TODO: Dont use the separated centers array ? maybe just send centerColors to the worker ?
            centerColors,
            covariances,
            scaleRotations
        };
    }
}