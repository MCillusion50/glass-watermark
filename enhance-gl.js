// 画质增强：8 邻域 unsharp mask + 轻微局部对比
// 纯 GPU 一遍过，420 万像素也只要几毫秒

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSize;      // 纹理尺寸（像素）
uniform float uAmount;   // 锐化强度
uniform float uContrast; // 局部对比
out vec4 frag;

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 px = 1.0 / uSize;
  vec3 c = texture(uTex, uv).rgb;

  vec3 b = (
    texture(uTex, uv + vec2(px.x, 0.0)).rgb +
    texture(uTex, uv - vec2(px.x, 0.0)).rgb +
    texture(uTex, uv + vec2(0.0, px.y)).rgb +
    texture(uTex, uv - vec2(0.0, px.y)).rgb +
    texture(uTex, uv + vec2(px.x, px.y)).rgb +
    texture(uTex, uv - vec2(px.x, px.y)).rgb +
    texture(uTex, uv + vec2(px.x, -px.y)).rgb +
    texture(uTex, uv - vec2(px.x, -px.y)).rgb
  ) / 8.0;

  vec3 s = c + (c - b) * uAmount;

  // 轻微 S 形：亮部再提一点，暗部压一点，看起来更"透"
  s = (s - 0.5) * (1.0 + uContrast) + 0.5;

  frag = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}

export function createEnhancer() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: false, preserveDrawingBuffer: true, antialias: false, depth: false,
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

  const uTex = gl.getUniformLocation(prog, 'uTex');
  const uSize = gl.getUniformLocation(prog, 'uSize');
  const uAmount = gl.getUniformLocation(prog, 'uAmount');
  const uContrast = gl.getUniformLocation(prog, 'uContrast');

  return {
    run(source, { amount = 0.9, contrast = 0.08 } = {}) {
      const w = source.width;
      const h = source.height;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.uniform1i(uTex, 0);
      gl.uniform2f(uSize, w, h);
      gl.uniform1f(uAmount, amount);
      gl.uniform1f(uContrast, contrast);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      return canvas;
    },
  };
}
