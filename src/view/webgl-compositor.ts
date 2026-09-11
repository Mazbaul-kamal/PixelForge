import { hasActiveMask, styledLayerFor, surfaceFor } from '../core/compositor';
import { hasBackdropStyles } from '../core/layer-styles';
import type { LiveStroke } from '../core/compositor';
import type { PixelDocument } from '../core/document';
import { BLEND_MODES } from '../core/types';

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position;
  gl_Position = vec4(a_position * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * One layer composited over the backdrop.
 *
 * The quad is always the full document, and the layer's own rectangle arrives
 * as a uniform in the same 0..1 space. That keeps the backdrop lookup a plain
 * `v_uv` fetch, so a layer never has to know where it sits in the stack.
 *
 * The separable blend modes work per channel; hue, saturation, colour and
 * luminosity need the whole colour at once, which is why they get helpers.
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColour;

uniform sampler2D u_layer;
uniform sampler2D u_backdrop;
uniform sampler2D u_mask;
uniform vec4 u_layerRect;
uniform vec4 u_maskRect;
uniform float u_opacity;
uniform int u_mode;
uniform bool u_hasMask;
uniform bool u_passthrough;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }

vec3 clipColour(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColour(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mn = min(min(c.r, c.g), c.b);
  float mx = max(max(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}

// Dodge and burn have to keep their spec-mandated corners: a black backdrop
// stays black even under a white source, and a white backdrop stays white.
float dodge1(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}
float burn1(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}

vec3 blend(vec3 b, vec3 s, int mode) {
  if (mode == 1) return b * s;
  if (mode == 2) return b + s - b * s;
  if (mode == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (mode == 4) return min(b, s);
  if (mode == 5) return max(b, s);
  if (mode == 6) return vec3(dodge1(b.r, s.r), dodge1(b.g, s.g), dodge1(b.b, s.b));
  if (mode == 7) return vec3(burn1(b.r, s.r), burn1(b.g, s.g), burn1(b.b, s.b));
  if (mode == 8) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));
  if (mode == 9) {
    vec3 d = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(vec3(0.25), b));
    return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
  }
  if (mode == 10) return abs(b - s);
  if (mode == 11) return b + s - 2.0 * b * s;
  if (mode == 12) return setLum(setSat(s, sat(b)), lum(b));
  if (mode == 13) return setLum(setSat(b, sat(s)), lum(b));
  if (mode == 14) return setLum(s, lum(b));
  if (mode == 15) return setLum(b, lum(s));
  return s;
}

bool inside(vec2 uv) {
  return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}

void main() {
  vec4 dst = texture(u_backdrop, v_uv);
  if (u_passthrough) { outColour = dst; return; }

  // Premultiplied throughout, so scaling by coverage scales rgb with alpha.
  vec4 src = vec4(0.0);
  vec2 luv = (v_uv - u_layerRect.xy) / u_layerRect.zw;
  if (inside(luv)) {
    src = texture(u_layer, luv);
    if (u_hasMask) {
      vec2 muv = (v_uv - u_maskRect.xy) / u_maskRect.zw;
      // The mask is greyscale, so its luminance is the coverage.
      float m = inside(muv) ? dot(texture(u_mask, muv).rgb, vec3(0.2126, 0.7152, 0.0722)) : 0.0;
      src *= m;
    }
  }
  src *= u_opacity;

  vec3 b = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);
  vec3 s = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 colour = src.a * mix(s, blend(b, s, u_mode), dst.a) + (1.0 - src.a) * dst.rgb;
  outColour = vec4(colour, src.a + dst.a * (1.0 - src.a));
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) === true) return shader;
  gl.deleteShader(shader);
  return null;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

interface CachedLayer {
  texture: WebGLTexture;
  source: HTMLCanvasElement | null;
  bytes: number;
  mask: WebGLTexture | null;
  maskSource: HTMLCanvasElement | null;
  maskBytes: number;
  revision: number;
}

/**
 * A WebGL2 compositor: one texture per layer, blend modes as fragment shaders.
 *
 * It covers the common case — layers with opacity, blend modes and masks.
 * Groups, clipping runs, adjustment layers and mask previews stay with the
 * Canvas 2D compositor, so the two paths always agree rather than the GL path
 * quietly dropping something a document depends on.
 */
export class WebGLCompositor {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly cache = new Map<string, CachedLayer>();
  private targets: [Target, Target] | null = null;
  private width = 0;
  private height = 0;
  private lost = false;
  private readonly maxTextureSize: number;
  /**
   * The shader always references the mask sampler, so unit 2 must hold a
   * complete texture even when the layer has no mask. A driver is entitled to
   * refuse the draw otherwise, and a refused draw is a black canvas.
   */
  private readonly blankMask: WebGLTexture;
  /**
   * Which document shape has been proved to work. Textures are the thing most
   * likely to fail to allocate, so growing the document or the layer stack
   * earns another check rather than being assumed to be fine.
   */
  private validatedFor = '';

  lastComposeMs = 0;

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, program: WebGLProgram) {
    this.canvas = canvas;
    this.gl = gl;
    this.program = program;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    this.blankMask = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blankMask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.uniforms = {};
    for (const name of ['u_layer', 'u_backdrop', 'u_mask', 'u_layerRect', 'u_maskRect',
      'u_opacity', 'u_mode', 'u_hasMask', 'u_passthrough']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    // A lost context must not paint a black canvas; it hands back to 2D.
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
    });
  }

  /** Null when WebGL2 is unavailable or the shaders will not build. */
  static create(): WebGLCompositor | null {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) return null;

    // Every pass un-premultiplies the backdrop to blend against it. At 8 bits
    // that division throws away colour precision wherever alpha is low, and
    // the error compounds with each layer, so a deep stack drifts away from
    // what Canvas 2D produces. Half-float intermediates keep the two paths
    // identical; without them the GL path is not worth having.
    if (!gl.getExtension('EXT_color_buffer_half_float')
      && !gl.getExtension('EXT_color_buffer_float')) return null;

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) return null;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    return new WebGLCompositor(canvas, gl, program);
  }

  /** True when every layer is something the shader path reproduces exactly. */
  canHandle(doc: PixelDocument, maskPreview: string | null): boolean {
    if (this.lost) return false;
    if (maskPreview !== null) return false;
    const max = this.maxTextureSize;
    if (doc.width > max || doc.height > max) return false;

    for (const layer of doc.layers) {
      if (layer.type === 'group' || layer.type === 'adjustment') return false;
      if (layer.clipped === true) return false;
      if (layer.parentId !== undefined) return false;
      // A drop shadow or outer glow has to blend with the document beneath
      // the layer, which this path composites one quad at a time and cannot
      // reach. Interior effects bake into the surface and are fine.
      if (hasBackdropStyles(layer)) return false;
      if (layer.canvas.width > max || layer.canvas.height > max) return false;
    }
    return true;
  }

  get textureBytes(): number {
    // The ping-pong pair is RGBA16F, so eight bytes a pixel each.
    let total = this.width * this.height * 8 * 2;
    for (const entry of this.cache.values()) total += entry.bytes + entry.maskBytes;
    return total;
  }

  private upload(
    texture: WebGLTexture | null,
    source: HTMLCanvasElement,
    premultiply: boolean,
  ): WebGLTexture | null {
    const { gl } = this;
    const target = texture ?? gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // The composite is at document resolution and so are the layers, so the
    // mapping is 1:1 and nearest sampling is exact.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return target;
  }

  private ensureTargets(): [Target, Target] | null {
    const { gl } = this;
    if (this.targets) return this.targets;

    const make = (): Target | null => {
      const texture = gl.createTexture();
      const framebuffer = gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.width, this.height, 0,
        gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
      return { texture, framebuffer };
    };

    const a = make();
    const b = make();
    if (!a || !b) return null;
    this.targets = [a, b];
    return this.targets;
  }

  private resize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.validatedFor = '';

    if (this.targets) {
      for (const target of this.targets) {
        this.gl.deleteTexture(target.texture);
        this.gl.deleteFramebuffer(target.framebuffer);
      }
      this.targets = null;
    }
  }

  /**
   * Composites the document into this canvas.
   *
   * `revision` changes whenever a layer's pixels may have moved underneath us;
   * a live stroke is uploaded every frame because that is the one layer that
   * really is changing.
   */
  compose(doc: PixelDocument, live: LiveStroke | null, revision: number): boolean {
    if (this.lost) return false;
    const started = performance.now();
    const { gl, uniforms } = this;

    this.resize(doc.width, doc.height);
    const targets = this.ensureTargets();
    if (!targets) return false;

    gl.useProgram(this.program);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.uniform1i(uniforms.u_layer ?? null, 0);
    gl.uniform1i(uniforms.u_backdrop ?? null, 1);
    gl.uniform1i(uniforms.u_mask ?? null, 2);

    let read = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets[read]!.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const seen = new Set<string>();
    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      if (layer.canvas.width === 0 || layer.canvas.height === 0) continue;
      seen.add(layer.id);

      const painting = live !== null && live.layerId === layer.id;
      // surfaceFor folds the live stroke and the mask together, so a layer
      // being painted needs no separate mask pass.
      const plain = painting ? surfaceFor(layer, live) : layer.canvas;

      // Interior effects are baked into a padded surface that sits at its own
      // origin, which the rect uniform handles without any special case. The
      // effects are generated from the masked shape, so that surface has the
      // mask in it already and the shader must not apply it a second time.
      const styled = styledLayerFor(layer, painting ? plain : surfaceFor(layer));
      const source = styled ? styled.surface.canvas : plain;
      const originX = styled ? styled.surface.x : layer.x;
      const originY = styled ? styled.surface.y : layer.y;
      const mask = !painting && !styled && hasActiveMask(layer) ? layer.mask ?? null : null;

      let entry = this.cache.get(layer.id);
      if (!entry) {
        entry = {
          texture: gl.createTexture(), source: null, bytes: 0,
          mask: null, maskSource: null, maskBytes: 0, revision: -1,
        };
        this.cache.set(layer.id, entry);
      }

      if (painting || entry.source !== source || entry.revision !== revision) {
        this.upload(entry.texture, source, true);
        entry.source = painting ? null : source;
        entry.bytes = source.width * source.height * 4;
      }

      if (mask) {
        if (entry.maskSource !== mask || entry.revision !== revision) {
          entry.mask = this.upload(entry.mask, mask, false);
          entry.maskSource = mask;
          entry.maskBytes = mask.width * mask.height * 4;
        }
      } else if (entry.mask) {
        gl.deleteTexture(entry.mask);
        entry.mask = null;
        entry.maskSource = null;
        entry.maskBytes = 0;
      }
      entry.revision = revision;

      const write = 1 - read;
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[write]!.framebuffer);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, targets[read]!.texture);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, entry.mask ?? this.blankMask);

      gl.uniform1i(uniforms.u_passthrough ?? null, 0);
      gl.uniform1i(uniforms.u_hasMask ?? null, entry.mask ? 1 : 0);
      gl.uniform1f(uniforms.u_opacity ?? null, Math.min(1, Math.max(0, layer.opacity)));
      gl.uniform1i(uniforms.u_mode ?? null, Math.max(0, BLEND_MODES.indexOf(layer.blendMode)));
      this.setRect(uniforms.u_layerRect ?? null, originX, originY, source.width, source.height);
      if (mask) this.setRect(uniforms.u_maskRect ?? null, layer.x, layer.y, mask.width, mask.height);
      else this.setRect(uniforms.u_maskRect ?? null, 0, 0, this.width, this.height);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      read = write;
    }

    for (const [id, entry] of this.cache) {
      if (seen.has(id)) continue;
      gl.deleteTexture(entry.texture);
      if (entry.mask) gl.deleteTexture(entry.mask);
      this.cache.delete(id);
    }

    // Straight through to the visible canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(uniforms.u_passthrough ?? null, 1);
    gl.uniform1i(uniforms.u_hasMask ?? null, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.blankMask);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.blankMask);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targets[read]!.texture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.lastComposeMs = performance.now() - started;

    // getError can stall the pipeline, so it only runs when the document has
    // grown into a shape that has not been proved to work yet.
    const shape = `${this.width}x${this.height}:${this.cache.size}`;
    if (this.validatedFor === shape) return true;

    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
      // Out of texture memory, or a driver that gave up. Being slow in Canvas
      // 2D beats handing the user a black canvas, so this path stays off.
      this.lost = true;
      return false;
    }
    this.validatedFor = shape;
    return true;
  }

  /** Document-space rectangle as 0..1, with y flipped to match the textures. */
  private setRect(
    location: WebGLUniformLocation | null,
    x: number, y: number, width: number, height: number,
  ): void {
    this.gl.uniform4f(
      location,
      x / this.width,
      1 - (y + height) / this.height,
      width / this.width,
      height / this.height,
    );
  }

  destroy(): void {
    this.gl.deleteTexture(this.blankMask);
    for (const entry of this.cache.values()) {
      this.gl.deleteTexture(entry.texture);
      if (entry.mask) this.gl.deleteTexture(entry.mask);
    }
    this.cache.clear();
  }
}
