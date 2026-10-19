import * as THREE from 'three';
import {KSplatHeader, SplatBuffer, UncompressedSplatArray} from '../../build/gaussian-splats-3d.module.js';

const SH_C0 = 0.28209479177387814;

//
// GLB Standard Constants
//
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

/**
 * Converts splats in the .glb format (KHR_gaussian_splatting extension) into .kstree node data.
 * TODO: Add support for spherical harmonics (only SH_DEGREE_0_COEF_0 is read for now)
 */
export class SplatTilesConverter {

    /**
     * Returns a list of non-empty nodes of a tree with their tile index (level, x, y, z) and a .glb file path.
     * @param {SplatSubTree} subTree
     * @return {Array<{node: SplatTreeNode, level: number, x: number, y: number, z: number, path: string}>}
     */
    static getTiles(subTree) {
        const tiles = [];
        const stack = [{ node: subTree.rootNode, level: 0, x: 0, y: 0, z: 0 }];
        while (stack.length > 0) {
            const tile = stack.pop();
            const { node, level, x, y, z } = tile;
            if (node.data && node.data.indexes && node.data.indexes.length > 0) {
                tile.path = `${level}/${x}/${y}/${z}.glb`;
                tiles.push(tile);
            }
            // Child positions computed from bounds so it doesnt depend on the order of the children
            // Even though node.key might already contain the x, y and z tile coords, when comming from 
            // a regular SplatBuffer it may not have them, so we generate them here anyway 
            for (const child of node.children) {
                const cx = child.center.x > node.center.x ? 1 : 0;
                const cy = child.center.z > node.center.z ? 1 : 0;
                const cz = child.center.y > node.center.y ? 1 : 0;
                stack.push({ node: child, level: level + 1, x: 2 * x + cx, y: 2 * y + cy, z: 2 * z + cz });
            }
        }
        return tiles;
    }

    /**
     * Reads the splats of a node .glb (first mesh primitive with KHR_gaussian_splatting).
     * The node translation is added to the positions.
     * TODO: ADD SUPPORT FOR rotation, scale or any matrix transform
     * @param {ArrayBuffer | Uint8Array} glbData
     * @return {UncompressedSplatArray | null} The same format as the .ply parsers output.
     */
    static read(glbData) {
        const resGlb = SplatTilesConverter.parseGLB(glbData);
        if (!resGlb) {
            return null;
        }

        const json = resGlb.json;
        const bin = resGlb.bin;

        const node = json.nodes.find((n) => n.mesh !== undefined);
        if (!node) {
            console.error('SplatTilesConverter: no mesh node found')
            return null;
        };
        if (node.matrix || node.rotation || node.scale) {
            console.error('SplatTilesConverter::read: node matrix, rotation and scale are not supported');
            return null;
        }
        const t = node.translation || [0, 0, 0];

        const primitive = json.meshes[node.mesh].primitives[0];
        if (!primitive.extensions || !primitive.extensions.KHR_gaussian_splatting) {
            console.error('SplatTilesConverter::read: the primitive does not use KHR_gaussian_splatting');
            return null;
        }
        const attribute = (name) => {
            const accessorIndex = primitive.attributes[name];
            if (accessorIndex === undefined) {
                console.error(`SplatTilesConverter::read::attribute: missing attribute ${name}`);
                return null
            }
            return SplatTilesConverter.readAccessor(json, bin, accessorIndex);
        };

        const positions = attribute('POSITION');
        const scales = attribute('KHR_gaussian_splatting:SCALE');
        const rotations = attribute('KHR_gaussian_splatting:ROTATION');
        const opacities = attribute('KHR_gaussian_splatting:OPACITY');
        const sh0 = attribute('KHR_gaussian_splatting:SH_DEGREE_0_COEF_0');

        if (!positions || !scales || !rotations || !opacities || !sh0) {
            return null;
        }

        const toByte = (v) => Math.min(255, Math.max(0, Math.round(v * 255)));

        const count = opacities.length;
        const splatArray = new UncompressedSplatArray(0);
        for (let i = 0; i < count; i++) {
            const i3 = i * 3;
            const i4 = i * 4;
            splatArray.addSplat([
                positions[i3] + t[0], positions[i3 + 1] + t[1], positions[i3 + 2] + t[2],
                scales[i3], scales[i3 + 1], scales[i3 + 2],
                rotations[i4 + 3], rotations[i4], rotations[i4 + 1], rotations[i4 + 2],
                toByte(0.5 + SH_C0 * sh0[i3]), toByte(0.5 + SH_C0 * sh0[i3 + 1]), toByte(0.5 + SH_C0 * sh0[i3 + 2]),
                toByte(opacities[i])
            ]);
        }
        return splatArray;
    }

    /**
     * Writes the splats of a node back into a .kstree SplatBuffer.
     * @param {SplatBuffer} splatBuffer The .kstree SplatBuffer
     * @param {Array<number>} indexes Global splat indexes of the node (node.data.indexes)
     * @param {UncompressedSplatArray | null} splatArray Splats of the node, in the same order as indexes
     */
    static writeNodeData(splatBuffer, indexes, splatArray) {
        if (splatArray.splatCount !== indexes.length) {
            console.error(`SplatTilesConverter: Splat count mismatch (node: ${indexes.length}, glb: ${splatArray.splatCount})`);
            return null;
        }

        const header = splatBuffer.header;
        const bucketCenter = new THREE.Vector3();
        for (let i = 0; i < indexes.length; i++) {
            const section = header.sections[splatBuffer.globalSplatIndexToSectionMap[indexes[i]]];
            const localSplatIndex = indexes[i] - section.splatCountOffset;
            if (header.compressionLevel >= 1) {
                const bucketBase = splatBuffer.getBucketIndex(section, localSplatIndex) * KSplatHeader.BucketStorageSizeFloats;
                bucketCenter.fromArray(section.bucketArray, bucketBase);
            }

            SplatBuffer.writeSplatDataToSectionBuffer(
                splatArray.splats[i],
                splatBuffer.bufferData,
                section.dataBase + localSplatIndex * section.bytesPerSplat,
                header.compressionLevel,
                0,
                bucketCenter,
                1 / section.compressionScaleFactor,
                section.compressionScaleRange
            );
        }
    }

    static parseGLB(glbData) {
        const bytes = glbData instanceof Uint8Array ? glbData : new Uint8Array(glbData);

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
            console.error('SplatTilesConverter::parseGLB: The file format is not glTF 2.0');
            return null;
        }

        let json = null;
        let bin = null;
        let offset = 12;
        while (offset + 8 <= bytes.byteLength) {
            const chunkLength = view.getUint32(offset, true);
            const chunkType = view.getUint32(offset + 4, true);
            const chunk = bytes.subarray(offset + 8, offset + 8 + chunkLength);
            if (chunkType === GLB_CHUNK_JSON)
                json = JSON.parse(new TextDecoder().decode(chunk));
            else if (chunkType === GLB_CHUNK_BIN && !bin)
                bin = chunk;
            offset += 8 + chunkLength;
        }
        if (!json || !bin) {
            console.error('SplatTilesConverter::parseGLB: Missing JSON or BIN chunk');
            return null;
        }
        return { json, bin };
    }

    /**
     * Reads an accessor into a packed Float32Array
     */
    static readAccessor(json, bin, accessorIndex) {
        const accessor = json.accessors[accessorIndex];
        if (accessor.bufferView === undefined || accessor.sparse) {
            console.error(`SplatTilesConverter::readAccessor: Accessor ${accessorIndex} has no data (compressed or sparse data is not supported)`);
            return null;
        }
        const bufferView = json.bufferViews[accessor.bufferView];
        const [elementSize, getter, maxValue] = COMPONENT_TYPES[accessor.componentType];
        const components = TYPE_COMPONENTS[accessor.type];
        const stride = bufferView.byteStride || components * elementSize;
        const view = new DataView(bin.buffer, bin.byteOffset + (bufferView.byteOffset || 0) + (accessor.byteOffset || 0));

        // Normalized integers as defined by the glTF spec
        const scale = accessor.normalized ? 1 / maxValue : 1;
        const min = accessor.normalized ? -1 : -Infinity;

        const out = new Float32Array(accessor.count * components);
        for (let i = 0; i < accessor.count; i++) {
            for (let c = 0; c < components; c++) {
                out[i * components + c] = Math.max(min, view[getter](i * stride + c * elementSize, true) * scale);
            }
        }
        return out;
    }
}