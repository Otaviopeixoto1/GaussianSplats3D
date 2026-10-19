
// TODO: Run this on a worker
export function parseSplatGLB(arrayBuffer, format, minimumAlpha) {
    const SH_C0 = 0.28209479177387814;
    const SPLAT_RENDER_MODE_TWO_D = 1;

    const GLB_MAGIC = 0x46546C67;
    const GLB_CHUNK_JSON = 0x4E4F534A;
    const GLB_CHUNK_BIN = 0x004E4942;

    // componentType: [byte size, DataView getter, max value]
    const COMPONENT_TYPES = {
        5120: [1, 'getInt8', 127],
        5121: [1, 'getUint8', 255],
        5122: [2, 'getInt16', 32767],
        5123: [2, 'getUint16', 65535],
        5125: [4, 'getUint32', 0],
        5126: [4, 'getFloat32', 0]
    };
    const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

    // Conversion table from 32 bit float to 16 bit float. Taken from: https://github.com/mrdoob/three.js/blob/r161/src/extras/DataUtils.js (Fast Half Float Conversions paper: http://www.fox-toolkit.org/ftp/fasthalffloatconversion.pdf)
    const halfFloatTables = function () {
        const baseTable = new Uint32Array(512);
        const shiftTable = new Uint32Array(512);
        for (let i = 0; i < 256; ++i) {
            const e = i - 127;
            if (e < -27) {
                baseTable[i] = 0x0000;
                baseTable[i | 0x100] = 0x8000;
                shiftTable[i] = 24;
                shiftTable[i | 0x100] = 24;
            } else if (e < -14) {
                baseTable[i] = 0x0400 >> (-e - 14);
                baseTable[i | 0x100] = (0x0400 >> (-e - 14)) | 0x8000;
                shiftTable[i] = -e - 1;
                shiftTable[i | 0x100] = -e - 1;
            } else if (e <= 15) {
                baseTable[i] = (e + 15) << 10;
                baseTable[i | 0x100] = ((e + 15) << 10) | 0x8000;
                shiftTable[i] = 13;
                shiftTable[i | 0x100] = 13;
            } else if (e < 128) {
                baseTable[i] = 0x7c00;
                baseTable[i | 0x100] = 0xfc00;
                shiftTable[i] = 24;
                shiftTable[i | 0x100] = 24;
            } else {
                baseTable[i] = 0x7c00;
                baseTable[i | 0x100] = 0xfc00;
                shiftTable[i] = 13;
                shiftTable[i | 0x100] = 13;
            }
        }
        return { baseTable, shiftTable };
    }();
    const floatView = new Float32Array(1);
    const uint32View = new Uint32Array(floatView.buffer);
    const toHalfFloat = (val) => {
        floatView[0] = Math.min(65504, Math.max(-65504, val));
        const f = uint32View[0];
        const e = (f >> 23) & 0x1ff;
        return halfFloatTables.baseTable[e] + ((f & 0x007fffff) >> halfFloatTables.shiftTable[e]);
    };

    const parseGLB = (arrayBuffer) => {
        if (arrayBuffer.byteLength < 12) return { error: 'file too small to be a .glb' };
        const bytes = new Uint8Array(arrayBuffer);
        const view = new DataView(arrayBuffer);
        if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
            return { error: 'not a glTF 2.0 binary file' };
        }
        let json = null;
        let bin = null;
        let offset = 12;
        while (offset + 8 <= bytes.byteLength) {
            const chunkLength = view.getUint32(offset, true);
            const chunkType = view.getUint32(offset + 4, true);
            if (offset + 8 + chunkLength > bytes.byteLength) return { error: 'truncated chunk' };
            const chunk = bytes.subarray(offset + 8, offset + 8 + chunkLength);
            if (chunkType === GLB_CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(chunk));
            else if (chunkType === GLB_CHUNK_BIN && !bin) bin = chunk;
            offset += 8 + chunkLength;
        }
        if (!json || !bin) return { error: 'missing JSON or BIN chunk' };
        return { json, bin };
    };

    // Reads an accessor into Float32Array (handles byteStride and normalized integers).
    // Returns null when the accessor has no data, an unsupported type or does not fit.
    const readAccessor = (json, bin, accessorIndex) => {
        const accessor = json.accessors && json.accessors[accessorIndex];
        if (!accessor || accessor.bufferView === undefined || accessor.sparse) return null;

        const bufferView = json.bufferViews && json.bufferViews[accessor.bufferView];
        const componentType = COMPONENT_TYPES[accessor.componentType];
        const components = TYPE_COMPONENTS[accessor.type];

        if (!bufferView || !componentType || !components) return null;

        const [elementSize, getter, maxValue] = componentType;
        const stride = bufferView.byteStride || components * elementSize;
        const start = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);

        if (accessor.count > 0 && start + (accessor.count - 1) * stride + components * elementSize > bin.byteLength) return null;

        const view = new DataView(bin.buffer, bin.byteOffset + start);

        // Fast path: tightly packed float32
        if (getter === 'getFloat32' && stride === components * 4 && view.byteOffset % 4 === 0) {
            return new Float32Array(view.buffer, view.byteOffset, accessor.count * components).slice();
        }

        // Normalized integers: max(v / maxValue, -1) as defined by the glTF spec
        const scale = accessor.normalized ? 1 / maxValue : 1;
        const min = accessor.normalized ? -1 : -Infinity;
        const out = new Float32Array(accessor.count * components);
        for (let i = 0; i < accessor.count; i++) {
            for (let c = 0; c < components; c++) {
                out[i * components + c] = Math.max(min, view[getter](i * stride + c * elementSize, true) * scale);
            }
        }
        return out;
    };



    const glb = parseGLB(arrayBuffer);
    if (glb.error) return glb;
    const { json, bin } = glb;

    const node = json.nodes && json.nodes.find((n) => n.mesh !== undefined);
    if (!node) return { error: 'no mesh node found' };
    if (node.matrix || node.rotation || node.scale) return { error: 'node matrix / rotation / scale are not supported' };

    const t = node.translation || [0, 0, 0];
    const mesh = json.meshes && json.meshes[node.mesh];

    const primitive = mesh && mesh.primitives && mesh.primitives[0];
    if (!primitive || !primitive.attributes) return { error: 'no mesh primitive found' };
    const get = (name) => {
        if (primitive.attributes[name] === undefined) return null;
        return readAccessor(json, bin, primitive.attributes[name]);
    };

    const positions = get('POSITION');
    const scales = get('KHR_gaussian_splatting:SCALE');
    const rotations = get('KHR_gaussian_splatting:ROTATION');
    const opacities = get('KHR_gaussian_splatting:OPACITY');
    const sh0 = get('KHR_gaussian_splatting:SH_DEGREE_0_COEF_0');

    if (!positions || !scales || !rotations || !opacities || !sh0) return { error: 'missing or invalid splat attributes' };
    const n = opacities.length;

    if (positions.length !== n * 3 || scales.length !== n * 3 || rotations.length !== n * 4 || sh0.length !== n * 3) {
        return { error: 'splat attributes have different counts' };
    }

    // centerColors: [rgba8, floatBits(x), floatBits(y), floatBits(z)]
    const centers = new Float32Array(n * 3);
    const centerColors = new Uint32Array(n * 4);
    const centerColorsFloat = new Float32Array(centerColors.buffer);
    const toByte = (v) => Math.min(255, Math.max(0, Math.round(v * 255)));
    for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const i4 = i * 4;
        centers[i3] = positions[i3] + t[0];
        centers[i3 + 1] = positions[i3 + 1] + t[1];
        centers[i3 + 2] = positions[i3 + 2] + t[2];
        let alpha = toByte(opacities[i]);
        if (alpha < minimumAlpha) { alpha = 0; }

        centerColors[i4] = (toByte(0.5 + SH_C0 * sh0[i3]) | (toByte(0.5 + SH_C0 * sh0[i3 + 1]) << 8) |
            (toByte(0.5 + SH_C0 * sh0[i3 + 2]) << 16) | (alpha << 24)) >>> 0;

        centerColorsFloat[i4 + 1] = centers[i3];
        centerColorsFloat[i4 + 2] = centers[i3 + 1];
        centerColorsFloat[i4 + 3] = centers[i3 + 2];
    }

    const result = { splatCount: n, centers, centerColors };

    if (format.splatRenderMode === SPLAT_RENDER_MODE_TWO_D) {
        // scaleRotations: [sx, sy, 1, qx, qy, qz] with w >= 0 (z scale is forced to 1 like SplatMesh)
        const scaleRotations = new Float32Array(n * 6);
        for (let i = 0; i < n; i++) {
            let x = rotations[i * 4];
            let y = rotations[i * 4 + 1];
            let z = rotations[i * 4 + 2];
            let w = rotations[i * 4 + 3];
            const s = (w < 0 ? -1 : 1) / (Math.hypot(x, y, z, w) || 1);
            x *= s; y *= s; z *= s;
            scaleRotations.set([scales[i * 3], scales[i * 3 + 1], 1, x, y, z], i * 6);
        }
        result.scaleRotations = scaleRotations;
        return result;
    }

    // Covariance = (R S)(R S)^T, [xx, xy, xz, yy, yz, zz] (same as SplatBuffer.computeCovariance)
    const half = format.covarianceCompressionLevel >= 1;
    const covariances = half ? new Uint32Array(n * 4) : new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
        const x = rotations[i * 4];
        const y = rotations[i * 4 + 1];
        const z = rotations[i * 4 + 2];
        const w = rotations[i * 4 + 3];
        const sx = scales[i * 3];
        const sy = scales[i * 3 + 1];
        const sz = scales[i * 3 + 2];
        // M = R * S
        const m00 = (1 - 2 * (y * y + z * z)) * sx;
        const m01 = 2 * (x * y - w * z) * sy;
        const m02 = 2 * (x * z + w * y) * sz;
        const m10 = 2 * (x * y + w * z) * sx;
        const m11 = (1 - 2 * (x * x + z * z)) * sy;
        const m12 = 2 * (y * z - w * x) * sz;
        const m20 = 2 * (x * z - w * y) * sx;
        const m21 = 2 * (y * z + w * x) * sy;
        const m22 = (1 - 2 * (x * x + y * y)) * sz;
        const xx = m00 * m00 + m01 * m01 + m02 * m02;
        const xy = m00 * m10 + m01 * m11 + m02 * m12;
        const xz = m00 * m20 + m01 * m21 + m02 * m22;
        const yy = m10 * m10 + m11 * m11 + m12 * m12;
        const yz = m10 * m20 + m11 * m21 + m12 * m22;
        const zz = m20 * m20 + m21 * m21 + m22 * m22;
        if (half) {
            // One RGBA32UI texel: 6 halfs + 2 padding halfs (SplatDataPacking.packHalfCovariances)
            const o = i * 4;
            covariances[o] = (toHalfFloat(xx) | (toHalfFloat(xy) << 16)) >>> 0;
            covariances[o + 1] = (toHalfFloat(xz) | (toHalfFloat(yy) << 16)) >>> 0;
            covariances[o + 2] = (toHalfFloat(yz) | (toHalfFloat(zz) << 16)) >>> 0;
            covariances[o + 3] = 0;
        } else {
            covariances.set([xx, xy, xz, yy, yz, zz], i * 6);
        }
    }
    result.covariances = covariances;
    return result;
}