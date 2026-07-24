import { Group } from 'three';


export class AbortablePromise<T = any> {
    public static idGen: number;
    public promise: Promise<any>;
    public abortHandler: ((reason?: any) => void) | undefined;
    public id: number;

    constructor(
        promiseFunc: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void,
        abortHandler?: (reason?: any) => void
    );

    public then<TResult = any>(
        onResolve: (...args: any[]) => TResult | PromiseLike<TResult> | AbortablePromise<TResult>
    ): AbortablePromise<TResult>;

    public catch(onFail: (error: any) => any): AbortablePromise<any>;
    public abort(reason?: any): void;
}

export class AbortedPromiseError extends Error {
    constructor(msg?: string);
}


export enum RenderMode {
    Always = 0,
    OnChange = 1,
    Never = 2
}

export enum SplatRenderMode {
    ThreeD = 0,
    TwoD = 1
}

export enum SceneRevealMode {
    Default = 0,
    Gradual = 1,
    Instant = 2
}

export enum LogLevel {
    None = 0,
    Error = 1,
    Warning = 2,
    Info = 3,
    Debug = 4
}

export enum WebXRMode {
    None = 0,
    VR = 1,
    AR = 2
}

export interface ViewerOptions {
    cameraUp: [number, number, number];
    initialCameraPosition: [number, number, number];
    initialCameraLookAt: [number, number, number];
    selfDrivenMode: boolean;
    renderer: THREE.WebGLRenderer;
    camera: THREE.Camera;
    useBuiltInControls: boolean;
    ignoreDevicePixelRatio: boolean;
    gpuAcceleratedSort: boolean;
    enableSIMDInSort: boolean;
    sharedMemoryForWorkers: boolean;
    integerBasedSort: boolean;
    splatSortDistanceMapPrecision: number;
    halfPrecisionCovariancesOnGPU: boolean;
    dynamicScene: boolean;
    webXRMode: WebXRMode;
    webXRSessionInit: any;
    renderMode: RenderMode;
    sceneRevealMode: SceneRevealMode;
    antialiased: boolean;
    kernel2DSize: number;
    focalAdjustment: number;
    logLevel: LogLevel;
    sphericalHarmonicsDegree: number;
    enableOptionalEffects: boolean;
    optimizeSplatData: boolean;
    inMemoryCompressionLevel: number;
    freeIntermediateSplatData: boolean;
    splatRenderMode: SplatRenderMode;
    sceneFadeInRateMultiplier: number;
}

export enum SceneFormat {
    Splat = 0,
    KSplat = 1,
    Ply = 2,
    Spz = 3
}

export enum LoaderStatus {
    Downloading = 0,
    Processing = 1,
    Done = 2
}

export interface SplatSceneOptions {
    format: SceneFormat;
    splatAlphaRemovalThreshold: number;
    showLoadingUI: boolean;
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
    progressiveLoad: boolean;
    onProgress: (progress: number, percentCompleteLabel: string, loaderStatus: LoaderStatus) => void;
    headers: Record<string, string | string[]>;
}

export class Viewer {
    constructor(options: Partial<ViewerOptions>);
    public addSplatScene(path: string, options: Partial<SplatSceneOptions>): AbortablePromise;
    public dispose(): Promise<void>;
}

export class DropInViewer extends Group {
    constructor(options: Partial<ViewerOptions>);
    public addSplatScene(path: string, options: Partial<SplatSceneOptions>): AbortablePromise;
    public dispose(): Promise<void>;
}