// 液态玻璃：按 Kyant0/AndroidLiquidGlass 的组合原样移植（Apache-2.0）
//   1. vibrancy()  饱和度 ×1.5
//   2. blur(8dp)   背景模糊
//   3. lens(24dp, 24dp, chromatic)  折射（注意 amount 传入前取负）
//   4. Highlight.Default  0.5dp 细描边，白色 Plus 叠加，角度 45°
//   5. onDrawSurface { containerColor }  表面色

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;

uniform sampler2D uTex;
uniform vec2  uPhoto;
uniform vec2  uOffset;
uniform vec4  uRect;
uniform float uRadius;
uniform float uRefH;      // refractionHeight
uniform float uRefA;      // refractionAmount（正数，着色器里取负）
uniform float uDepth;     // depthEffect
uniform float uDisp;      // chromaticAberration：0 或 1
uniform float uSat;       // vibrancy 1.5
uniform vec3  uSurface;   // containerColor
uniform float uSurfaceA;
uniform float uOutSize;

out vec4 frag;

float sdRoundedRect(vec2 coord, vec2 halfSize, float radius) {
  vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));
  float outside = length(max(cornerCoord, 0.0)) - radius;
  float inside = min(max(cornerCoord.x, cornerCoord.y), 0.0);
  return outside + inside;
}

vec2 gradSdRoundedRect(vec2 coord, vec2 halfSize, float radius) {
  vec2 cornerCoord = abs(coord) - (halfSize - vec2(radius));
  if (cornerCoord.x >= 0.0 || cornerCoord.y >= 0.0) {
    vec2 v = max(cornerCoord, 0.0);
    float l = length(v);
    return l < 1e-6 ? vec2(0.0) : sign(coord) * (v / l);
  }
  float gradX = step(cornerCoord.y, cornerCoord.x);
  return sign(coord) * vec2(gradX, 1.0 - gradX);
}

float circleMap(float x) { return 1.0 - sqrt(max(0.0, 1.0 - x * x)); }

vec4 contentAt(vec2 px) {
  return texture(uTex, clamp(px / uPhoto, vec2(0.0), vec2(1.0)));
}

void main() {
  vec2 fc = vec2(gl_FragCoord.x, uOutSize - gl_FragCoord.y);
  vec2 photoPx = uOffset + fc;

  vec2 halfSize = uRect.zw * 0.5;
  vec2 centeredCoord = photoPx - (uRect.xy + halfSize);

  float radius = min(uRadius, min(halfSize.x, halfSize.y));
  float sd = sdRoundedRect(centeredCoord, halfSize, radius);
  float cov = 1.0 - smoothstep(-1.0, 1.0, sd);
  if (sd > 1.2) discard;

  float gradRadius = min(radius * 1.5, min(halfSize.x, halfSize.y));
  vec2 grad = gradSdRoundedRect(centeredCoord, halfSize, gradRadius);

  vec4 color;
  if (-sd >= uRefH || uRefA < 0.01) {
    color = contentAt(photoPx);
  } else {
    float sdClamped = min(sd, 0.0);
    // 库里的写法：refractionAmount 传进着色器时是负的
    float d = circleMap(1.0 - (-sdClamped) / uRefH) * (-uRefA);
    vec2 g = normalize(grad + uDepth * normalize(centeredCoord + vec2(1e-6)));
    vec2 refracted = photoPx + d * g;

    if (uDisp < 0.5) {
      color = contentAt(refracted);
    } else {
      float dispersionIntensity = (centeredCoord.x * centeredCoord.y) / (halfSize.x * halfSize.y);
      vec2 dispersed = d * g * dispersionIntensity;
      vec4 s;
      color = vec4(0.0);
      s = contentAt(refracted + dispersed);                color.r += s.r / 3.5; color.a += s.a / 7.0;
      s = contentAt(refracted + dispersed * (2.0 / 3.0));  color.r += s.r / 3.5; color.g += s.g / 7.0; color.a += s.a / 7.0;
      s = contentAt(refracted + dispersed * (1.0 / 3.0));  color.r += s.r / 3.5; color.g += s.g / 3.5; color.a += s.a / 7.0;
      s = contentAt(refracted);                            color.g += s.g / 3.5; color.a += s.a / 7.0;
      s = contentAt(refracted - dispersed * (1.0 / 3.0));  color.g += s.g / 3.5; color.b += s.b / 3.0; color.a += s.a / 7.0;
      s = contentAt(refracted - dispersed * (2.0 / 3.0));  color.b += s.b / 3.0; color.a += s.a / 7.0;
      s = contentAt(refracted - dispersed);                color.r += s.r / 7.0; color.b += s.b / 3.0; color.a += s.a / 7.0;
      color.a = 1.0;
    }
  }

  vec3 col = color.rgb;

  // vibrancy()
  float luma = dot(col, vec3(0.213, 0.715, 0.072));
  col = mix(vec3(luma), col, uSat);

  // onDrawSurface { drawRect(containerColor) }
  col = mix(col, uSurface, uSurfaceA);

  // Highlight.Default：0.5dp 描边 + |dot(grad, 45°)| * 0.5，Plus 叠加
  float strokeHalf = 0.5 * max(1.0, uRefH * 0.03);
  float stroke = 1.0 - smoothstep(strokeHalf - 0.5, strokeHalf + 0.5, abs(sd));
  vec2 normal = vec2(cos(0.785398), sin(0.785398));
  float hi = pow(abs(dot(grad, normal)), 1.0);
  col += vec3(1.0) * stroke * hi * 0.5;
  col = min(col, vec3(1.0));

  float alpha = max(cov, stroke * 0.5);
  frag = vec4(col, alpha);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || 'shader');
  }
  return s;
}

export function createGlassRenderer() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
    depth: false,
  });
  if (!gl) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let uploaded = null;

  const u = {};
  for (const name of ['uTex', 'uPhoto', 'uOffset', 'uRect', 'uRadius', 'uRefH', 'uRefA',
    'uDepth', 'uDisp', 'uSat', 'uSurface', 'uSurfaceA', 'uOutSize']) {
    u[name] = gl.getUniformLocation(prog, name);
  }

  return {
    render({ source, rect, radius, refractH, refractA, depth, disp, sat, surface, surfaceA, pad }) {
      const w = Math.ceil(rect.w) + pad * 2;
      const h = Math.ceil(rect.h) + pad * 2;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      if (uploaded !== source) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        uploaded = source;
      }

      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);

      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(u.uTex, 0);
      gl.uniform2f(u.uPhoto, source.width, source.height);
      gl.uniform2f(u.uOffset, rect.x - pad, rect.y - pad);
      gl.uniform4f(u.uRect, rect.x, rect.y, rect.w, rect.h);
      gl.uniform1f(u.uRadius, radius);
      gl.uniform1f(u.uRefH, refractH);
      gl.uniform1f(u.uRefA, refractA);
      gl.uniform1f(u.uDepth, depth);
      gl.uniform1f(u.uDisp, disp);
      gl.uniform1f(u.uSat, sat);
      gl.uniform3f(u.uSurface, surface[0], surface[1], surface[2]);
      gl.uniform1f(u.uSurfaceA, surfaceA);
      gl.uniform1f(u.uOutSize, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);

      return { canvas, x: rect.x - pad, y: rect.y - pad };
    },
  };
}
