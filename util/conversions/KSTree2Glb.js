#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { SplatBuffer, KSplatTreeLoader } from '../../build/gaussian-splats-3d.module.js';
import { SplatTilesConverter } from './SplatTileConverter.js';

// Dynamically import playcanvas/splat-transform
let splatTransform;
try {
    splatTransform = await import('@playcanvas/splat-transform');
} catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    console.error('kstree2glb needs @playcanvas/splat-transform. Run: npm install --save-dev @playcanvas/splat-transform');
    process.exit(1);
}
const { readKsplat, writeGlb, MemoryReadFileSystem, MemoryFileSystem, Transform } = splatTransform;


/**
 * Simple CLI for converting .kstree into tiled GLTF files (.glb) following implicing tiling 
 */

if (process.argv.length < 4) {
    console.log('Expected at least 2 arguments!');
    console.log('Usage: kstree2glb [path to .kstree] [output directory]');
    console.log('Writes one [output directory]/level/x/y/z.glb (KHR_gaussian_splatting) per non empty node of the tree');
    process.exit(1);
}

const inputFile = process.argv[2];
const outputDirectory = process.argv[3];

const fileData = new Uint8Array(fs.readFileSync(inputFile));
KSplatTreeLoader.checkVersion(fileData.buffer);
const splatBuffer = new SplatBuffer(fileData.buffer);
const subTree = KSplatTreeLoader.loadTree(splatBuffer);

// Splat data (SplatTransform reads the .kstree as a .ksplat and ignores the tree at the end of the file).
// dataTable rows are in SplatBuffer order, this allows the node indexes can be used directly as row indexes.
const readFileSystem = new MemoryReadFileSystem();
readFileSystem.set('input.ksplat', fileData);
const dataTable = await readKsplat(await readFileSystem.createSource('input.ksplat'));

// writeGlb would rotate it 180 degrees around Z into glTF space.
// Keep the .kstree coordinates instead so the splats stay consistent with our coord system
dataTable.transform = Transform.IDENTITY;

const writeFileSystem = new MemoryFileSystem();
let splatCount = 0;
let byteCount = 0;
const tiles = SplatTilesConverter.getTiles(subTree);
for (const tile of tiles) {
    await writeGlb({ filename: tile.path, dataTable: dataTable.clone({ rows: tile.node.data.indexes }) }, writeFileSystem);
    const glb = writeFileSystem.results.get(tile.path);
    writeFileSystem.results.delete(tile.path);

    const outputFile = path.join(outputDirectory, tile.path);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, glb);

    splatCount += tile.node.data.indexes.length;
    byteCount += glb.byteLength;
}

console.log(`Wrote ${tiles.length} tiles (${splatCount} splats) to ${outputDirectory}`);