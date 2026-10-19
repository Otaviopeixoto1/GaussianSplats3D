import { ITiledSplatFileLoader } from "../TiledSplatFileLoader.js"
import { parseSplatGLB } from "./SplatGlbParser.js"

//TODO: This would need to load multiple tiles if receiving the full tileset. 
// PARSE THE TILESET BEFORE, MAKE ONE TILESET AND MAKE ONE LOADER PER TILE
export class Tiles3DLoader extends ITiledSplatFileLoader {

    constructor(tilsetUrl) {
        super()

        //TODO: Load the tilset json and get the baseUrl
    }

    async loadNode(level, x, y, z, format) {
        const res = await fetch(`${this.baseUrl}/${level}/${x}/${y}/${z}.glb`);
        if (!res.ok) {
            console.error(`Tiles3DLoader::loadNode: HTTP ERROR ${res.status}`);
            return null;
        };

        return parseSplatGLB(
            await res.arrayBuffer(),
            format,
            0 //TODO: add min alpha from parameters
        );
    };

    async loadSubtree(level, x, y, z) {
        //TODO: FOR NOW LOAD FROM THE SPLATBUFFER
        return null;
    }



    //
    // TODO: IMPLEMENT STATIC FUNCTIONS THAT SPLIT A TILESET INTO MULTIPLE Tiles3DLoader, ONE PER TILE
    //

}