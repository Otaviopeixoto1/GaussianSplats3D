import { ITiledSplatFileLoader } from "../TiledSplatFileLoader.js"
import { parseSplatGLB } from "./SplatGlbParser.js"
import {fetchWithProgress} from "../../Util.js";
import {VirtualSplatBuffer} from "../SplatBuffer.js";
import {KSplatTreeLoader} from "../ksplat/KSplatTreeLoader.js";

//TODO: This would need to load multiple tiles if receiving the full tileset. 
// PARSE THE TILESET BEFORE, MAKE ONE TILESET AND MAKE ONE LOADER PER TILE
export class Tiles3DLoader extends ITiledSplatFileLoader {

    constructor(tileset) {
        super()
        this.baseUrl = tileset.root.children[0].root.content.uri;

        // TODO: LOAD THE subtree:
        this.rootSubtree = null;
        this.treeUrl = tileset.root.children[0].root.implicitTiling.subtrees.uri;

        this.splatSubTreePromise = null;
        if (this.treeUrl) {
            this.splatSubTreePromise = KSplatTreeLoader.loadHeader(this.treeUrl).then((header) => {

                if (header) {
                    return KSplatTreeLoader.loadTree(header, this.treeUrl).then((subTree) => {
                        this.rootSubtree = subTree;
                    });
                }
            });
        } else {
            console.error("Tiles3DLoader: Invalid Subtree")
        }
    }

    async waitSubtree() {
        if (this.splatSubTreePromise !== null) {
            await this.splatSubTreePromise;
            this.splatSubTreePromise = null;
        }
    }

    async loadNode(level, x, y, z, format) {
        await this.waitSubtree();
        const res = await fetch(`${this.baseUrl}/${level}/${x}/${y}/${z}.glb`);
        if (!res.ok) {
            console.error(`Tiles3DLoader::loadNode: HTTP ERROR ${res.status}`);
            return null;
        }

        return parseSplatGLB(
            await res.arrayBuffer(),
            format,
            0 //TODO: add min alpha from parameters
        );
    };

    async loadSubtree(level, x, y, z) {
        const isRootNode = level === 0 && x === 0 && y === 0 && z === 0;
        if (!isRootNode) {
            return null
        }

        await this.waitSubtree();
        return this.rootSubtree;
    }



    //
    // TODO: IMPLEMENT STATIC FUNCTIONS THAT SPLIT A TILESET INTO MULTIPLE Tiles3DLoader, ONE PER TILE
    //
    static loadTilestFromURL(fileName, headers) {

        const localOnProgress = (percent, percentStr, chunk) => {
            return;
        };

        return fetchWithProgress(fileName, localOnProgress, true).then((fullBuffer) => {
            const tileset = JSON.parse(new TextDecoder().decode(fullBuffer));
            const loader = new Tiles3DLoader(tileset);
            return new VirtualSplatBuffer(loader);
        });
    }

}