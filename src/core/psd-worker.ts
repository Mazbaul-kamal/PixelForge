import { readPsd } from 'ag-psd';

export interface PsdLayerData {
  readonly name: string;
  readonly left: number;
  readonly top: number;
  readonly opacity: number;
  readonly blendMode: string | undefined;
  readonly hidden: boolean;
  readonly clipping: boolean;
  readonly isGroup: boolean;
  readonly opened: boolean;
  readonly text: string | undefined;
  readonly imageData: ImageData | undefined;
  readonly maskData: ImageData | undefined;
  readonly maskLeft: number;
  readonly maskTop: number;
  readonly children: PsdLayerData[];
}

export interface PsdParseResult {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly colourMode: number;
  readonly bitsPerChannel: number;
  readonly layers: PsdLayerData[];
  readonly composite: ImageData | undefined;
  readonly error?: string;
}

/** ag-psd's layer shape, narrowed to what the importer reads. */
interface RawLayer {
  name?: string;
  left?: number;
  top?: number;
  opacity?: number;
  blendMode?: string;
  hidden?: boolean;
  clipping?: boolean;
  opened?: boolean;
  children?: RawLayer[];
  imageData?: ImageData;
  text?: { text?: string };
  mask?: { imageData?: ImageData; left?: number; top?: number };
}

function convertLayer(layer: RawLayer): PsdLayerData {
  const children = layer.children ?? [];
  return {
    name: layer.name ?? 'Layer',
    left: layer.left ?? 0,
    top: layer.top ?? 0,
    opacity: layer.opacity ?? 1,
    blendMode: layer.blendMode,
    hidden: layer.hidden === true,
    clipping: layer.clipping === true,
    isGroup: children.length > 0 || layer.opened !== undefined,
    opened: layer.opened !== false,
    text: layer.text?.text,
    imageData: layer.imageData,
    maskData: layer.mask?.imageData,
    maskLeft: layer.mask?.left ?? 0,
    maskTop: layer.mask?.top ?? 0,
    children: children.map(convertLayer),
  };
}

function collectTransfers(layers: readonly PsdLayerData[], into: ArrayBuffer[]): void {
  for (const layer of layers) {
    if (layer.imageData) into.push(layer.imageData.data.buffer as ArrayBuffer);
    if (layer.maskData) into.push(layer.maskData.data.buffer as ArrayBuffer);
    collectTransfers(layer.children, into);
  }
}

self.addEventListener('message', (event: MessageEvent<{ id: number; buffer: ArrayBuffer }>) => {
  const { id, buffer } = event.data;

  try {
    // useImageData because a worker has no document to make canvases with,
    // and ImageData transfers without being re-encoded.
    const psd = readPsd(buffer, {
      useImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
    }) as unknown as {
      width: number; height: number; colorMode?: number; bitsPerChannel?: number;
      children?: RawLayer[]; imageData?: ImageData;
    };

    const layers = (psd.children ?? []).map(convertLayer);
    const result: PsdParseResult = {
      id,
      width: psd.width,
      height: psd.height,
      colourMode: psd.colorMode ?? 3,
      bitsPerChannel: psd.bitsPerChannel ?? 8,
      layers,
      composite: psd.imageData,
    };

    const transfers: ArrayBuffer[] = [];
    collectTransfers(layers, transfers);
    if (result.composite) transfers.push(result.composite.data.buffer as ArrayBuffer);

    (self as unknown as Worker).postMessage(result, transfers);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The file could not be read.';
    (self as unknown as Worker).postMessage({
      id, width: 0, height: 0, colourMode: 3, bitsPerChannel: 8,
      layers: [], composite: undefined, error: message,
    } satisfies PsdParseResult);
  }
});
