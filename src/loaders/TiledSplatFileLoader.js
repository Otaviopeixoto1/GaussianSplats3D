import {SplatSubTree} from "../splattree/SplatTree.js";


export class ITiledSplatFileLoader {

    /**
     * @abstract method for loading node data from a file in the specified indexes
     * @param {number} level
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {SplatDataFormat} format
     * @return {Promise<Object | null>} Node data or null if node is empty
     */
    async loadNode(level, x, y, z, format) { return null; };

    /**
     * @abstract method for loading subtree data from a file in the specified indexes
     * @param {number} level
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @return {Promise<SplatSubTree | null>} Node data or null if node is empty
     */
    async loadSubtree(level, x, y, z) { return null; }

    /**
     * Method for loading a byte range from a file
     * @return {Promise<ArrayBuffer | null>}
     */
    static async fetchBytes(url, from, to) {
        const res = await fetch(url, {headers: {
            'Content-Type': "arraybuffer",
            'Range': `bytes=${from}-${to}`
        }});

        if (!res.ok) {
            console.error("FAILED FETCHING BYTES", res.status, res.statusText)
            return null;
        }


        return await res.arrayBuffer();
    }
}