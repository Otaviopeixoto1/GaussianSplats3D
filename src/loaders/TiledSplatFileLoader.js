import { SplatSubTree } from "../splattree/SplatTree.js";


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
     * Method for loading a byte range from a file. 
     * If "to" is not provided, the range from "from"" to the end of the file is loaded
     * @return {Promise<ArrayBuffer | null>}
     */
    static async fetchBytes(url, from, to) {
        const range = to === undefined ? `bytes=${from}-` : `bytes=${from}-${to}`;
        const res = await fetch(url, {
            headers: {
                'Range': range
            }
        });

        if (!res.ok) {
            console.error("FAILED FETCHING BYTES", res.status, res.statusText)
            return null;
        }

        const buffer = await res.arrayBuffer();

        // 206: the server sent only the range. 200: the server ignored the Range header and sent the whole file
        if (res.status === 200) {
            console.warn("ITiledSplatFileLoader::fetchBytes is getting the full range of the fi")
            return buffer.slice(from, to === undefined ? undefined : to + 1);
        }
        return buffer;
    }
}