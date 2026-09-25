import * as THREE from "three";

export class Constants {

    static DefaultSplatSortDistanceMapPrecision = 16;
    static MemoryPageSize = 65536;
    static BytesPerFloat = 4;
    static BytesPerInt = 4;
    static MaxScenes = 32;
    static ProgressiveLoadSectionSize = 262144;
    static ProgressiveLoadSectionDelayDuration = 15;
    static SphericalHarmonics8BitCompressionRange = 3;

    //
    // Splat Constants:
    //
    static dummyGeometry = new THREE.BufferGeometry();
    static dummyMaterial = new THREE.MeshBasicMaterial();

    static COVARIANCES_ELEMENTS_PER_SPLAT = 6;
    static CENTER_COLORS_ELEMENTS_PER_SPLAT = 4;

    static COVARIANCES_ELEMENTS_PER_TEXEL_STORED = 4;
    static COVARIANCES_ELEMENTS_PER_TEXEL_ALLOCATED = 4;
    static COVARIANCES_ELEMENTS_PER_TEXEL_COMPRESSED_STORED = 6;
    static COVARIANCES_ELEMENTS_PER_TEXEL_COMPRESSED_ALLOCATED = 8;
    static SCALES_ROTATIONS_ELEMENTS_PER_TEXEL = 4;
    static CENTER_COLORS_ELEMENTS_PER_TEXEL = 4;
    static SCENE_INDEXES_ELEMENTS_PER_TEXEL = 1;

    static SCENE_FADEIN_RATE_FAST = 0.012;
    static SCENE_FADEIN_RATE_GRADUAL = 0.003;

    static VISIBLE_REGION_EXPANSION_DELTA = 1;

    // Based on my own observations across multiple devices, OSes and browsers, using textures that have one dimension
    // greater than 4096 while the other is greater than or equal to 4096 causes issues (Essentially any texture larger
    // than 4096 x 4096 (16777216) texels). Specifically it seems all texture data beyond the 4096 x 4096 texel boundary
    // is corrupted, while data below that boundary is usable. In these cases the texture has been valid in the eyes of
    // both Three.js and WebGL, and the texel format (RG, RGBA, etc.) has not mattered. More investigation will be needed,
    // but for now the work-around is to split the spherical harmonics into three textures (one for each color channel).
    static MAX_TEXTURE_TEXELS = 16777216;
}
