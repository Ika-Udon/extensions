(function (Scratch) {
  'use strict';

  const blockIconURI = 'data:image/svg+xml;base64,' + btoa(`
    <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#7c6cf0"/>
          <stop offset="100%" stop-color="#00d2d3"/>
        </linearGradient>
      </defs>
      <rect fill="url(#g)" width="40" height="40" rx="4"/>
      <path d="M10 10h20v20H10z" fill="#fff" opacity="0.2"/>
      <path d="M14 14h12v12H14z" fill="#fff" opacity="0.6"/>
      <path d="M18 18h4v4h-4z" fill="#fff"/>
    </svg>
  `.trim());

  class ShaderManager {
    constructor() {
      this.shaders = new Map();
      this.activeShaders = [];
      this.targetShaders = new Map(); // targetId または spriteName => { activeShaders: [], uniformValues: {} }
      this.renderer = null;
      this.gl = null;
      this.quadBuffer = null;
      this.enabled = false;
      this.pingPongFBOs = [{ framebuffer: null, texture: null }, { framebuffer: null, texture: null }];
      this.sourceTexture = null;
      this.spriteSourceFBO = null;
      this.blitProgram = null;
      this.originalDrawFunction = null;
      this.isHooked = false;
      this.isDirty = true;
      this.isActive = false;
      this.animationFrameId = null;
      this.lastFrameTime = 0;
      this.customFps = 60;
      this.interval = 1000 / this.customFps;
      this.textureWidth = 0;
      this.textureHeight = 0;
      this.savedGLState = null;
      this.initialize();
    }

    initialize() {
      if (typeof Scratch === 'undefined' || !Scratch.vm || !Scratch.vm.renderer) {
        setTimeout(() => this.initialize(), 100);
        return;
      }
      try {
        this.renderer = Scratch.vm.renderer;
        this.gl = this.renderer.gl;
        if (!this.gl) return;
        this.setupBuffers();
        this.setupFBOs();
      } catch (err) {
        setTimeout(() => this.initialize(), 500);
      }
    }

    setupBuffers() {
      const gl = this.gl;
      const vertices = new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]);
      this.quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    setupFBOs() {
      const canvas = this.renderer.canvas;
      this.textureWidth = canvas.width;
      this.textureHeight = canvas.height;
      this.sourceTexture = this._createFBO(this.textureWidth, this.textureHeight);
      this.pingPongFBOs[0] = this._createFBO(this.textureWidth, this.textureHeight);
      this.pingPongFBOs[1] = this._createFBO(this.textureWidth, this.textureHeight);
      this.spriteSourceFBO = this._createFBO(this.textureWidth, this.textureHeight);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      if (!this.blitProgram) {
        this.setupBlitProgram();
      }
    }

    setupBlitProgram() {
      const vs = `
        attribute vec2 a_position;
        attribute vec2 a_texCoord;
        varying vec2 v_texCoord;
        void main() {
          gl_Position = vec4(a_position, 0.0, 1.0);
          v_texCoord = a_texCoord;
        }
      `;
      const fs = `
        precision mediump float;
        uniform sampler2D u_texture;
        varying vec2 v_texCoord;
        void main() {
          gl_FragColor = texture2D(u_texture, v_texCoord);
        }
      `;
      try {
        this.blitProgram = this.createProgram(vs, fs);
      } catch (err) {
        console.warn('[ShaderManager] setupBlitProgram error:', err);
      }
    }

    _drawTextureToCurrentFB(texture) {
      if (!this.blitProgram || !this.blitProgram.program || !this.gl) return;
      const gl = this.gl;
      gl.useProgram(this.blitProgram.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const uTex = gl.getUniformLocation(this.blitProgram.program, 'u_texture');
      if (uTex) gl.uniform1i(uTex, 0);

      const aPos = gl.getAttribLocation(this.blitProgram.program, 'a_position');
      const aTex = gl.getAttribLocation(this.blitProgram.program, 'a_texCoord');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      if (aPos >= 0) {
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      }
      if (aTex >= 0) {
        gl.enableVertexAttribArray(aTex);
        gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (aPos >= 0) gl.disableVertexAttribArray(aPos);
      if (aTex >= 0) gl.disableVertexAttribArray(aTex);
    }

    _createFBO(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { framebuffer: fb, texture: tex };
    }

    compileShader(source, type) {
      const gl = this.gl;
      if (!gl) throw new Error('No WebGL context');
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Compile error:\n${log}`);
      }
      return shader;
    }

    _parseConstDefaultValue(type, rawVal) {
      if (!rawVal) return 0;
      const clean = rawVal.trim();
      if (type === 'float' || type === 'int') {
        const num = parseFloat(clean);
        return isNaN(num) ? 0 : num;
      }
      if (type === 'bool') {
        return clean === 'true' || clean === '1';
      }
      if (type.startsWith('vec')) {
        const inside = clean.replace(/^[a-zA-Z0-9_]+\s*\(/, '').replace(/\)$/, '').trim();
        let parts = inside.split(',').map(s => {
          const n = parseFloat(s.trim());
          return isNaN(n) ? 0 : n;
        });
        const dim = parseInt(type.replace('vec', ''), 10) || 2;
        if (parts.length === 1 && dim > 1) {
          parts = Array(dim).fill(parts[0]);
        }
        return parts.join(',');
      }
      return clean;
    }

    _preprocessShader(source) {
      if (!source) return { source: '', defaultValues: {} };
      const defaultValues = {};
      let depth = 0;
      const lines = source.split('\n');
      const processedLines = lines.map(line => {
        const openCount = (line.match(/\{/g) || []).length;
        const closeCount = (line.match(/\}/g) || []).length;

        if (depth === 0) {
          // グローバルスコープの const 変数宣言をマッチして uniform に自動変換
          // 例: "  const float SPEED = 1.5; // コメント"
          //     "const mediump vec2 DIR = vec2(1.0, 0.0);"
          const constMatch = line.match(/^\s*const\s+(?:(highp|mediump|lowp)\s+)?([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)\s*=\s*([^;]+);(.*)$/);
          if (constMatch) {
            const precision = constMatch[1] ? constMatch[1] + ' ' : '';
            const type = constMatch[2];
            const name = constMatch[3];
            const rawVal = constMatch[4].trim();
            const restComment = constMatch[5] || '';

            if (!ShaderExtension.BUILTIN_UNIFORMS.has(name)) {
              defaultValues[name] = this._parseConstDefaultValue(type, rawVal);
              depth += (openCount - closeCount);
              return `uniform ${precision}${type} ${name}; // converted from const: ${rawVal}${restComment}`;
            }
          }
        }

        depth += (openCount - closeCount);
        if (depth < 0) depth = 0;
        return line;
      });

      return {
        source: processedLines.join('\n'),
        defaultValues
      };
    }

    createProgram(vertexSource, fragmentSource) {
      const gl = this.gl;
      if (!gl) throw new Error('No WebGL context');

      const vProcessed = this._preprocessShader(vertexSource);
      const fProcessed = this._preprocessShader(fragmentSource);
      const constDefaults = Object.assign({}, vProcessed.defaultValues, fProcessed.defaultValues);

      const vs = this.compileShader(vProcessed.source, gl.VERTEX_SHADER);
      const fs = this.compileShader(fProcessed.source, gl.FRAGMENT_SHADER);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`Link error:\n${log}`);
      }
      const uniforms = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        if (info) {
          uniforms[info.name] = {
            location: gl.getUniformLocation(program, info.name),
            type: info.type,
            size: info.size
          };
        }
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return { program, uniforms, constDefaults };
    }

    _compileJs(source) {
      if (!source || !source.trim()) return null;
      try {
        const fn = new Function(`
          ${source}
          return {
            onInit: typeof onInit !== 'undefined' ? onInit : null,
            onFrame: typeof onFrame !== 'undefined' ? onFrame : null
          };
        `);
        return fn();
      } catch (err) {
        console.warn('[ShaderManager] JS compile error:', err);
        return null;
      }
    }

    addShader(name, vertexSource, fragmentSource, jsSource = '', isIntegrated = false, children = [], activeChildren = []) {
      if (!this.gl) return { success: false, error: new Error('No WebGL context') };
      let data = { program: null, uniforms: {}, constDefaults: {} };
      let compileError = null;

      if (!isIntegrated) {
        try {
          data = this.createProgram(vertexSource, fragmentSource);
        } catch (e) {
          compileError = e;
        }
      }

      try {
        let wasActive = false;
        let oldUniformValues = {};
        let jsState = { initialized: false, module: null };

        if (this.shaders.has(name)) {
          wasActive = this.activeShaders.includes(name);
          const oldShader = this.shaders.get(name);
          oldUniformValues = oldShader.uniformValues || {};
          if (oldShader.program) this.gl.deleteProgram(oldShader.program);
          this.shaders.delete(name);
        }

        const initialUniformValues = Object.assign({}, data.constDefaults || {}, oldUniformValues);
        jsState.module = this._compileJs(jsSource);
        
        if (isIntegrated && children) {
          children.forEach(c => {
            if (!c.jsState) c.jsState = { initialized: false, module: null };
            c.jsState.module = this._compileJs(c.jsSource);
            c.jsState.initialized = false;
          });
        }

        this.shaders.set(name, {
          ...data,
          vertexSource,
          fragmentSource,
          jsSource,
          jsState,
          uniformValues: initialUniformValues,
          isIntegrated,
          children,
          activeChildren,
        });

        if (wasActive && !this.activeShaders.includes(name)) {
          this.activeShaders.push(name);
          this.enabled = true;
          this.startEffect();
        }

        return compileError ? { success: true, error: compileError } : { success: true };
      } catch (e) {
        return { success: false, error: e };
      }
    }

    addIntegratedShader(name, children = []) {
      const activeChildNames = children.map(c => typeof c === 'string' ? c : c.name);
      return this.addShader(name, '', '', '', true, children, activeChildNames);
    }

    removeShader(name) {
      if (!this.gl || !this.shaders.has(name)) return false;
      const shader = this.shaders.get(name);
      if (shader.program) this.gl.deleteProgram(shader.program);
      this.shaders.delete(name);
      const idx = this.activeShaders.indexOf(name);
      if (idx > -1) this.activeShaders.splice(idx, 1);
      
      // スプライトシェーダーからも除去
      for (const state of this.targetShaders.values()) {
        const sIdx = state.activeShaders.indexOf(name);
        if (sIdx > -1) state.activeShaders.splice(sIdx, 1);
      }

      this.checkActiveState();
      return true;
    }

    getShader(name) {
      return this.shaders.get(name);
    }

    setUniform(shaderName, uniformName, value) {
      const shader = this.shaders.get(shaderName);
      if (!shader) return false;
      if (!shader.uniformValues) shader.uniformValues = {};
      shader.uniformValues[uniformName] = value;
      this.requestImmediateRedraw();
      return true;
    }

    // スプライト用シェーダー管理
    hasAnySpriteShaders() {
      for (const state of this.targetShaders.values()) {
        if (state && state.activeShaders && state.activeShaders.length > 0) {
          return true;
        }
      }
      return false;
    }

    requestImmediateRedraw() {
      this.isDirty = true;
      if (this.renderer) {
        try {
          this.renderer.draw();
        } catch (e) {
          console.warn('[ShaderManager] redraw error:', e);
        }
      }
      if (Scratch.vm && Scratch.vm.runtime) {
        Scratch.vm.runtime.requestRedraw();
      }
    }

    checkActiveState() {
      if (this.activeShaders.length > 0 || this.hasAnySpriteShaders()) {
        this.enabled = true;
        this.startEffect();
      } else {
        this.enabled = false;
        this.stopEffect();
      }
      this.requestImmediateRedraw();
    }

    _getTargetState(targetKey, createIfMissing = false) {
      if (!this.targetShaders.has(targetKey)) {
        if (!createIfMissing) return null;
        this.targetShaders.set(targetKey, { activeShaders: [], uniformValues: {} });
      }
      return this.targetShaders.get(targetKey);
    }

    _resetShaderJsInit(shaderName) {
      if (!shaderName) return;
      const s = this.shaders.get(shaderName);
      if (s) {
        if (s.jsState) s.jsState.initialized = false;
        if (s.isIntegrated && s.children) {
          s.children.forEach(c => { if (c.jsState) c.jsState.initialized = false; });
        }
      }
    }

    _resetAllJsInit() {
      for (const shader of this.shaders.values()) {
        if (shader.jsState) shader.jsState.initialized = false;
        if (shader.isIntegrated && shader.children) {
          shader.children.forEach(c => { if (c.jsState) c.jsState.initialized = false; });
        }
      }
    }

    setTargetShader(targetKey, shaderName) {
      const state = this._getTargetState(targetKey, true);
      if (!shaderName) {
        state.activeShaders = [];
      } else {
        state.activeShaders = [shaderName];
        this._resetShaderJsInit(shaderName);
      }
      this.checkActiveState();
      this.saveShadersToProject();
    }

    setTargetShaderEnabled(targetKey, shaderName, enabled) {
      const state = this._getTargetState(targetKey, true);
      const idx = state.activeShaders.indexOf(shaderName);
      if (enabled) {
        if (idx === -1) state.activeShaders.push(shaderName);
        this._resetShaderJsInit(shaderName);
      } else {
        if (idx > -1) state.activeShaders.splice(idx, 1);
      }
      this.checkActiveState();
      this.saveShadersToProject();
    }

    clearTargetShaders(targetKey) {
      const state = this._getTargetState(targetKey, false);
      if (state) {
        state.activeShaders = [];
        this.checkActiveState();
        this.saveShadersToProject();
      }
    }

    setTargetUniform(targetKey, shaderName, uniformName, value) {
      const state = this._getTargetState(targetKey, true);
      if (!state.uniformValues[shaderName]) {
        state.uniformValues[shaderName] = {};
      }
      state.uniformValues[shaderName][uniformName] = value;
      this.requestImmediateRedraw();
      this.saveShadersToProject();
    }

    getTargetUniform(targetKey, shaderName, uniformName) {
      const state = this._getTargetState(targetKey, false);
      if (state && state.uniformValues[shaderName] && state.uniformValues[shaderName][uniformName] !== undefined) {
        return state.uniformValues[shaderName][uniformName];
      }
      const s = this.shaders.get(shaderName);
      if (s && s.uniformValues && s.uniformValues[uniformName] !== undefined) {
        return s.uniformValues[uniformName];
      }
      return '';
    }

    isTargetShaderActive(targetKey, shaderName) {
      const state = this._getTargetState(targetKey, false);
      return state ? state.activeShaders.includes(shaderName) : false;
    }

    _findTargetByDrawableID(drawableID) {
      if (!Scratch.vm || !Scratch.vm.runtime) return null;
      return Scratch.vm.runtime.targets.find(t => t.drawableID === drawableID) || null;
    }

    _getActiveShadersForTarget(target) {
      if (!target) return [];
      // 1. target.id 固有の設定（クローン単体等）
      const idState = this.targetShaders.get(target.id);
      if (idState && idState.activeShaders && idState.activeShaders.length > 0) {
        return idState.activeShaders;
      }
      // 2. target.getName() または target.sprite.name の設定（スプライト全体）
      const name = target.getName ? target.getName() : (target.sprite ? target.sprite.name : null);
      if (name) {
        const nameState = this.targetShaders.get(name);
        if (nameState && nameState.activeShaders && nameState.activeShaders.length > 0) {
          return nameState.activeShaders;
        }
      }
      return [];
    }

    _getUniformOverridesForTarget(target) {
      if (!target) return {};
      const overrides = {};
      const name = target.getName ? target.getName() : (target.sprite ? target.sprite.name : null);
      if (name) {
        const nameState = this.targetShaders.get(name);
        if (nameState && nameState.uniformValues) {
          for (const [sName, uMap] of Object.entries(nameState.uniformValues)) {
            overrides[sName] = { ...uMap };
          }
        }
      }
      const idState = this.targetShaders.get(target.id);
      if (idState && idState.uniformValues) {
        for (const [sName, uMap] of Object.entries(idState.uniformValues)) {
          overrides[sName] = { ...(overrides[sName] || {}), ...uMap };
        }
      }
      return overrides;
    }

    saveGLState() {
      const gl = this.gl;
      this.savedGLState = {
        viewport: gl.getParameter(gl.VIEWPORT),
        blendEq: gl.getParameter(gl.BLEND_EQUATION),
        blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
        blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB),
        blendSrcA: gl.getParameter(gl.BLEND_SRC_ALPHA),
        blendDstA: gl.getParameter(gl.BLEND_DST_ALPHA),
        depthFunc: gl.getParameter(gl.DEPTH_FUNC),
        depthTest: gl.isEnabled(gl.DEPTH_TEST),
        blend: gl.isEnabled(gl.BLEND),
        cullFace: gl.isEnabled(gl.CULL_FACE),
        scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
        currentProgram: gl.getParameter(gl.CURRENT_PROGRAM),
        arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
        tex2D: gl.getParameter(gl.TEXTURE_BINDING_2D),
        fb: gl.getParameter(gl.FRAMEBUFFER_BINDING),
        activeTex: gl.getParameter(gl.ACTIVE_TEXTURE)
      };
    }

    restoreGLState() {
      if (!this.savedGLState) return;
      const gl = this.gl;
      const s = this.savedGLState;
      gl.activeTexture(s.activeTex);
      gl.bindTexture(gl.TEXTURE_2D, s.tex2D);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuffer);
      gl.useProgram(s.currentProgram);
      gl.viewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]);
      s.blend ? gl.enable(gl.BLEND) : gl.disable(gl.BLEND);
      gl.blendEquation(s.blendEq);
      gl.blendFuncSeparate(s.blendSrcRGB, s.blendDstRGB, s.blendSrcA, s.blendDstA);
      s.depthTest ? gl.enable(gl.DEPTH_TEST) : gl.disable(gl.DEPTH_TEST);
      gl.depthFunc(s.depthFunc);
      s.cullFace ? gl.enable(gl.CULL_FACE) : gl.disable(gl.CULL_FACE);
      s.scissorTest ? gl.enable(gl.SCISSOR_TEST) : gl.disable(gl.SCISSOR_TEST);
    }

    hookRenderer() {
      if (this.isHooked || !this.renderer) return;
      this.originalDrawFunction = this.renderer._drawThese.bind(this.renderer);
      this.renderer._drawThese = (drawables, drawMode, projection, opts) => {
        if (!this.gl || !this.sourceTexture || !this.sourceTexture.framebuffer || !this.spriteSourceFBO) {
          this.originalDrawFunction(drawables, drawMode, projection, opts);
          return;
        }

        const hasGlobal = this.activeShaders.length > 0;
        const hasSprite = this.hasAnySpriteShaders();

        if (!hasGlobal && !hasSprite) {
          this.originalDrawFunction(drawables, drawMode, projection, opts);
          return;
        }

        const currentFB = this.gl.getParameter(this.gl.FRAMEBUFFER_BINDING);
        if (currentFB !== null) {
          this.originalDrawFunction(drawables, drawMode, projection, opts);
          return;
        }

        const canvas = this.gl.canvas;
        if (canvas.width !== this.textureWidth || canvas.height !== this.textureHeight) {
          this.setupFBOs();
        }

        const mainTargetFB = hasGlobal ? this.sourceTexture.framebuffer : null;

        if (hasGlobal) {
          // 背景やペン拡張の描画結果をシェーダー入力としてキャプチャする
          this.gl.bindTexture(this.gl.TEXTURE_2D, this.sourceTexture.texture);
          this.gl.copyTexSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, 0, 0, canvas.width, canvas.height);
          
          this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.sourceTexture.framebuffer);
          // キャプチャ済みのテクスチャにそのまま上書き描画するため、クリアは行わない
        }

        if (!hasSprite) {
          this.originalDrawFunction(drawables, drawMode, projection, opts);
        } else {
          this._drawWithSpriteShaders(drawables, drawMode, projection, opts, mainTargetFB);
        }

        if (hasGlobal) {
          this.saveGLState();
          try {
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
            this.applyShaderEffect();
          } catch (err) {
            console.warn('[ShaderManager] hook draw error:', err);
          } finally {
            this.restoreGLState();
          }
        }
        this.isDirty = true;
      };
      this.isHooked = true;
    }

    _drawWithSpriteShaders(drawables, drawMode, projection, opts, mainTargetFB) {
      const gl = this.gl;
      let batch = [];

      const flushBatch = () => {
        if (batch.length > 0) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, mainTargetFB);
          this.originalDrawFunction(batch, drawMode, projection, opts);
          batch = [];
        }
      };

      for (let i = 0; i < drawables.length; i++) {
        const drawableID = drawables[i];
        const target = this._findTargetByDrawableID(drawableID);
        const spriteShaders = target ? this._getActiveShadersForTarget(target) : null;

        if (!spriteShaders || spriteShaders.length === 0) {
          batch.push(drawableID);
        } else {
          flushBatch();
          this._drawSingleSpriteWithShaders(drawableID, drawMode, projection, opts, mainTargetFB, target, spriteShaders);
        }
      }

      flushBatch();
    }

    _drawSingleSpriteWithShaders(drawableID, drawMode, projection, opts, mainTargetFB, target, spriteShaders) {
      const gl = this.gl;
      const canvas = this.renderer.canvas;

      // 1. スプライト専用FBOに描画
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.spriteSourceFBO.framebuffer);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      this.originalDrawFunction([drawableID], drawMode, projection, opts);

      // 2. スプライトシェーダーのピンポン適用
      let srcTex = this.spriteSourceFBO.texture;
      let srcIdx = 0;
      const targetOverrides = this._getUniformOverridesForTarget(target);
      const renderPasses = this._flattenShaders(spriteShaders, [], {}, targetOverrides);

      if (renderPasses.length > 0) {
        for (let i = 0; i < renderPasses.length; i++) {
          const pass = renderPasses[i];
          const targetFBO = this.pingPongFBOs[1 - srcIdx].framebuffer;
          gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);

          this._applySingleShader(pass.shader, srcTex, pass.uniforms, target);

          srcTex = this.pingPongFBOs[1 - srcIdx].texture;
          srcIdx = 1 - srcIdx;
        }
      }

      // 3. 元のメインフレームバッファにブレンド描画
      gl.bindFramebuffer(gl.FRAMEBUFFER, mainTargetFB);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      this._drawTextureToCurrentFB(srcTex);
    }

    unhookRenderer() {
      if (!this.isHooked || !this.renderer || !this.originalDrawFunction) return;
      this.renderer._drawThese = this.originalDrawFunction;
      this.originalDrawFunction = null;
      this.isHooked = false;
      if (Scratch.vm && Scratch.vm.runtime) Scratch.vm.runtime.requestRedraw();
    }

    renderLoop(timestamp) {
      this.animationFrameId = requestAnimationFrame(this.renderLoop.bind(this));
      if (!this.isActive || (this.activeShaders.length === 0 && !this.hasAnySpriteShaders())) return;
      const delta = timestamp - this.lastFrameTime;
      if (delta < this.interval) return;
      this.lastFrameTime = timestamp - (delta % this.interval);

      // スプライトシェーダーがある場合、renderer.draw() を直接呼んで
      // _drawThese フックを同期的に発火させリアルタイム更新を実現
      if (this.hasAnySpriteShaders() && this.renderer) {
        this.renderer.draw();
        // draw() 内のフックで isDirty=true になるため、
        // 全画面シェーダーの二重適用は isDirty チェックで防止される
      }

      if (this.isDirty) {
        this.isDirty = false;
        return;
      }
      if (this.activeShaders.length > 0) {
        this.saveGLState();
        try {
          const canvas = this.gl.canvas;
          this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
          this.gl.viewport(0, 0, canvas.width, canvas.height);
          this.applyShaderEffect();
          this.gl.flush();
        } catch (err) {
        } finally {
          this.restoreGLState();
        }
      }
    }

    _flattenShaders(shadersList, results = [], parentUniforms = {}, targetOverrides = {}) {
      for (const item of shadersList) {
        const shader = (typeof item === 'string') ? this.shaders.get(item) : item;
        if (!shader) continue;
        const sName = (typeof item === 'string') ? item : shader.name;
        const spriteSpecificUniforms = (targetOverrides && targetOverrides[sName]) || {};
        const mergedUniforms = { ...shader.uniformValues, ...parentUniforms, ...spriteSpecificUniforms };
        if (shader.isIntegrated) {
          this._flattenShaders(
            shader.children.filter(c => shader.activeChildren && shader.activeChildren.includes(c.name)),
            results,
            mergedUniforms,
            targetOverrides
          );
        } else {
          results.push({ shader, uniforms: mergedUniforms });
        }
      }
      return results;
    }

    applyShaderEffect() {
      if (this.activeShaders.length === 0 || !this.gl) return;
      let srcTex = this.sourceTexture.texture;
      let srcIdx = 0;
      const renderPasses = this._flattenShaders(this.activeShaders);
      if (renderPasses.length === 0) return;
      for (let i = 0; i < renderPasses.length; i++) {
        const pass = renderPasses[i];
        const isLast = i === renderPasses.length - 1;
        const targetFBO = isLast ? null : this.pingPongFBOs[1 - srcIdx].framebuffer;
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, targetFBO);
        this._applySingleShader(pass.shader, srcTex, pass.uniforms, null, isLast);
        if (!isLast) {
          srcTex = this.pingPongFBOs[1 - srcIdx].texture;
          srcIdx = 1 - srcIdx;
        }
      }
    }

    _applySingleShader(shader, inputTexture, overrideUniforms = null, target = null, isFinalPass = false) {
      if (!shader.program) return;
      const gl = this.gl;
      const canvas = this.renderer.canvas;
      const activeUniformValues = overrideUniforms || shader.uniformValues;
      
      if (shader.jsState && shader.jsState.module) {
        const api = {
          gl: this.gl,
          time: performance.now() / 1000.0,
          setUniform: (name, value) => {
            activeUniformValues[name] = value;
          },
          canvas: canvas,
          stageWidth: Scratch.vm ? Scratch.vm.runtime.stageWidth : 480,
          stageHeight: Scratch.vm ? Scratch.vm.runtime.stageHeight : 360,
          target: target
        };
        if (!shader.jsState.initialized) {
          if (shader.jsState.module.onInit) {
            try { shader.jsState.module.onInit(api); } catch(e) { console.warn(e); }
          }
          shader.jsState.initialized = true;
        }
        if (shader.jsState.module.onFrame) {
          try { shader.jsState.module.onFrame(api); } catch(e) { console.warn(e); }
        }
      }

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(shader.program);
      
      if (isFinalPass) {
        gl.disable(gl.BLEND);
      } else {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      const uTex = gl.getUniformLocation(shader.program, 'u_texture');
      if (uTex) gl.uniform1i(uTex, 0);

      const uTime = gl.getUniformLocation(shader.program, 'u_time');
      if (uTime) gl.uniform1f(uTime, performance.now() / 1000.0);

      const nativeW = (Scratch.vm && Scratch.vm.runtime) ? Scratch.vm.runtime.stageWidth : 480;
      const nativeH = (Scratch.vm && Scratch.vm.runtime) ? Scratch.vm.runtime.stageHeight : 360;
      const uRes = gl.getUniformLocation(shader.program, 'u_resolution');
      if (uRes) gl.uniform2f(uRes, nativeW, nativeH);

      const uCanvasRes = gl.getUniformLocation(shader.program, 'u_canvasResolution');
      if (uCanvasRes) gl.uniform2f(uCanvasRes, canvas.width, canvas.height);

      const uPixelRatio = gl.getUniformLocation(shader.program, 'u_pixelRatio');
      if (uPixelRatio) gl.uniform1f(uPixelRatio, canvas.width / nativeW);

      // スプライト固有の uniforms
      const uIsSprite = gl.getUniformLocation(shader.program, 'u_isSprite');
      if (uIsSprite) gl.uniform1f(uIsSprite, target ? 1.0 : 0.0);

      const uSpritePos = gl.getUniformLocation(shader.program, 'u_spritePos');
      if (uSpritePos) gl.uniform2f(uSpritePos, target ? (target.x || 0) : 0, target ? (target.y || 0) : 0);

      const uSpriteSize = gl.getUniformLocation(shader.program, 'u_spriteSize');
      if (uSpriteSize) gl.uniform1f(uSpriteSize, target ? (target.size || 100) : 100);

      const uSpriteDir = gl.getUniformLocation(shader.program, 'u_spriteDirection');
      if (uSpriteDir) gl.uniform1f(uSpriteDir, target ? (target.direction !== undefined ? target.direction : 90) : 90);

      const uSpriteBounds = gl.getUniformLocation(shader.program, 'u_spriteBounds');
      if (uSpriteBounds) {
        if (target && target.getBounds) {
          const b = target.getBounds();
          gl.uniform4f(uSpriteBounds, b.left || 0, b.bottom || 0, b.right || 0, b.top || 0);
        } else {
          gl.uniform4f(uSpriteBounds, 0, 0, 0, 0);
        }
      }

      for (const [name, info] of Object.entries(shader.uniforms)) {
        const val = activeUniformValues[name];
        if (val === undefined) continue;
        switch (info.type) {
          case gl.FLOAT: gl.uniform1f(info.location, parseFloat(val)); break;
          case gl.FLOAT_VEC2: {
            const v = String(val).split(',').map(Number);
            gl.uniform2f(info.location, v[0]||0, v[1]||0);
            break;
          }
          case gl.FLOAT_VEC3: {
            const v = String(val).split(',').map(Number);
            gl.uniform3f(info.location, v[0]||0, v[1]||0, v[2]||0);
            break;
          }
          case gl.FLOAT_VEC4: {
            const v = String(val).split(',').map(Number);
            gl.uniform4f(info.location, v[0]||0, v[1]||0, v[2]||0, v[3]||0);
            break;
          }
          case gl.INT: gl.uniform1i(info.location, parseInt(val, 10)); break;
          case gl.BOOL: gl.uniform1i(info.location, (val === true || val === 'true' || val === 1 || val === '1') ? 1 : 0); break;
        }
      }

      const aPos = gl.getAttribLocation(shader.program, 'a_position');
      const aTex = gl.getAttribLocation(shader.program, 'a_texCoord');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      if (aPos >= 0) {
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      }
      if (aTex >= 0) {
        gl.enableVertexAttribArray(aTex);
        gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (aPos >= 0) gl.disableVertexAttribArray(aPos);
      if (aTex >= 0) gl.disableVertexAttribArray(aTex);
    }

    setEnabled(shaderName, enabled) {
      if (enabled) {
        if (this.shaders.has(shaderName) && !this.activeShaders.includes(shaderName)) {
          this.activeShaders.push(shaderName);
          this._resetShaderJsInit(shaderName);
          this.enabled = true;
          this.startEffect();
        }
      } else {
        const idx = this.activeShaders.indexOf(shaderName);
        if (idx > -1) this.activeShaders.splice(idx, 1);
        this.checkActiveState();
      }
      this.requestImmediateRedraw();
    }

    startEffect() {
      if (this.isActive || !this.renderer || !this.gl) return;
      this.isActive = true;
      this.hookRenderer();
      if (this.animationFrameId === null) {
        this.lastFrameTime = performance.now();
        this.renderLoop(this.lastFrameTime);
      }
      this.requestImmediateRedraw();
    }

    stopEffect() {
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      if (!this.isActive) return;
      this.isActive = false;
      this.unhookRenderer();
      this.requestImmediateRedraw();
    }

    setupProjectHooks() {
      if (Scratch.vm && Scratch.vm.runtime) {
        Scratch.vm.runtime.on('PROJECT_LOADED', () => this.loadShadersFromProject());
        Scratch.vm.runtime.on('PROJECT_START', () => this._resetAllJsInit());
      }
    }

    saveShadersToProject() {
      if (!Scratch.vm || !Scratch.vm.runtime) return;
      const serializeShader = (s) => ({
        name: s.name,
        vertexSource: s.vertexSource,
        fragmentSource: s.fragmentSource,
        jsSource: s.jsSource || '',
        uniformValues: s.uniformValues,
        isIntegrated: s.isIntegrated,
        children: s.children ? s.children.map(c => serializeShader(c)) : [],
        activeChildren: s.activeChildren || []
      });
      const data = Array.from(this.shaders.entries()).map(([name, s]) => ({ ...serializeShader({ name, ...s }) }));
      
      const spriteData = {};
      for (const [key, state] of this.targetShaders.entries()) {
        if (state.activeShaders.length > 0 || Object.keys(state.uniformValues).length > 0) {
          spriteData[key] = {
            activeShaders: [...state.activeShaders],
            uniformValues: JSON.parse(JSON.stringify(state.uniformValues))
          };
        }
      }

      Scratch.vm.runtime.extensionStorage['glslshader'] = { 
        shaders: data,
        activeShaders: [...this.activeShaders],
        spriteShaders: spriteData
      };
    }

    loadShadersFromProject() {
      if (!Scratch.vm || !Scratch.vm.runtime) return;
      const saved = Scratch.vm.runtime.extensionStorage['glslshader'];
      if (!saved || !saved.shaders) return;

      const parseShaderData = (data) => {
        const isIntegrated = data.isIntegrated;
        let children = [];
        let activeChildren = [];
        if (data.children) {
          children = data.children.map(c => {
            if (typeof c === 'string') {
              const sourceObj = saved.shaders.find(s => s.name === c);
              if (sourceObj && !sourceObj.isIntegrated) {
                const progData = this.createProgram(sourceObj.vertexSource, sourceObj.fragmentSource);
                return {
                  name: sourceObj.name,
                  vertexSource: sourceObj.vertexSource,
                  fragmentSource: sourceObj.fragmentSource,
                  jsSource: sourceObj.jsSource || '',
                  ...progData,
                  uniformValues: sourceObj.uniformValues || {},
                  isIntegrated: false,
                  children: [], activeChildren: []
                };
              }
              return null;
            } else {
              const progData = c.isIntegrated ? { program: null, uniforms: {} } : this.createProgram(c.vertexSource, c.fragmentSource);
              return {
                name: c.name,
                vertexSource: c.vertexSource,
                fragmentSource: c.fragmentSource,
                jsSource: c.jsSource || '',
                ...progData,
                uniformValues: c.uniformValues || {},
                isIntegrated: c.isIntegrated,
                children: c.children ? c.children.map(subC => parseShaderData(subC)) : [],
                activeChildren: c.activeChildren || []
              };
            }
          }).filter(Boolean);
        }
        if (data.activeChildren) {
          activeChildren = data.activeChildren.map(c => typeof c === 'string' ? c : c.name);
        } else if (isIntegrated && data.children) {
          activeChildren = children.map(c => c.name);
        }
        return { isIntegrated, children, activeChildren };
      };

      try {
        for (const shaderData of saved.shaders) {
          const { name, vertexSource, fragmentSource, jsSource, uniformValues } = shaderData;
          const parsed = parseShaderData(shaderData);
          const result = this.addShader(name, vertexSource, fragmentSource, jsSource || '', parsed.isIntegrated, parsed.children, parsed.activeChildren);
          if (result && result.success && uniformValues) {
            for (const [uName, uVal] of Object.entries(uniformValues)) {
              this.setUniform(name, uName, uVal);
            }
          }
        }
        if (saved.activeShaders) {
          this.activeShaders = [...saved.activeShaders];
        }
        if (saved.spriteShaders) {
          this.targetShaders.clear();
          for (const [key, sData] of Object.entries(saved.spriteShaders)) {
            this.targetShaders.set(key, {
              activeShaders: sData.activeShaders || [],
              uniformValues: sData.uniformValues || {}
            });
          }
        }
        this.checkActiveState();
        if (this.isHooked) this.isDirty = true;
      } catch (err) {
        console.warn('Load error:', err);
      }
    }
  }

  class GeminiService {
    constructor() {
      this.apiKey = localStorage.getItem('se_gemini_api_key') || '';
      this.model = localStorage.getItem('se_gemini_model') || 'gemini-2.5-flash';
    }

    setApiKey(key) {
      this.apiKey = (key || '').trim();
      localStorage.setItem('se_gemini_api_key', this.apiKey);
    }

    getApiKey() {
      return this.apiKey;
    }

    setModel(model) {
      this.model = model;
      localStorage.setItem('se_gemini_model', this.model);
    }

    getModel() {
      return this.model;
    }

    async listModels(apiKey = null) {
      const key = apiKey || this.apiKey;
      if (!key) {
        throw new Error('Gemini APIキーが設定されていません。');
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
      const response = await fetch(url, { method: 'GET' });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        throw new Error(`モデル一覧の取得に失敗しました: ${errMsg}`);
      }

      const data = await response.json();
      if (!data || !Array.isArray(data.models)) {
        return [];
      }

      // generateContent に対応し、かつ特殊用途（Embedding, Imagen, AQA, TTS等）を除いたGeminiモデルを抽出
      const contentModels = data.models
        .filter(m => {
          if (!m || !m.name) return false;
          const isGenerateContent = Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent');
          const name = m.name.toLowerCase();
          const isSpecialized = name.includes('embedding') ||
                                name.includes('imagen') ||
                                name.includes('aqa') ||
                                name.includes('tts') ||
                                name.includes('chirp') ||
                                name.includes('veo') ||
                                name.includes('learnlm');
          return isGenerateContent && !isSpecialized && name.includes('gemini');
        })
        .map(m => {
          const id = m.name.replace(/^models\//, '');
          const displayName = m.displayName ? `${m.displayName} (${id})` : id;
          return {
            id: id,
            displayName: displayName,
            description: m.description || '',
            inputLimit: m.inputTokenLimit,
            outputLimit: m.outputTokenLimit
          };
        });

      // モデルの並び順（最新の2.5, 2.0, 1.5, flash, pro を優先して整理）
      contentModels.sort((a, b) => {
        const getScore = (id) => {
          let s = 0;
          if (id.includes('2.5')) s += 1000;
          else if (id.includes('2.0')) s += 500;
          else if (id.includes('1.5')) s += 100;
          if (id.includes('pro')) s += 20;
          if (id.includes('flash')) s += 10;
          return -s;
        };
        return getScore(a.id) - getScore(b.id);
      });

      return contentModels;
    }

    async generateContent(prompt, systemInstruction = '') {
      if (!this.apiKey) {
        throw new Error('Gemini APIキーが設定されていません。AIパネルの「APIキー設定」から設定してください。');
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
      
      const body = {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      };

      if (systemInstruction) {
        body.systemInstruction = {
          parts: [{ text: systemInstruction }]
        };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        throw new Error(`Gemini APIエラー: ${errMsg}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Geminiから有効な応答を受信できませんでした。');
      }
      return text;
    }

    async chat(messages, currentData = null) {
      if (!this.apiKey) {
        throw new Error('Gemini APIキーが設定されていません。ヘッダーの「⚙️」からAPIキーを設定してください。');
      }

      const systemPrompt = `
あなたはWebGL / GLSLシェーダーおよびTurboWarp拡張の最高峰のAIアシスタントです。
ユーザーと自然に対話し、シェーダーの生成、修正、エラー修復、仕組みの解説、アルゴリズムの提案を行ってください。

【開発環境】
- WebGL 1.0 (GLSL ES 1.0)
- 組み込みUniform:
  - sampler2D u_texture (入力テクスチャ)
  - float u_time (秒単位の時間)
  - vec2 u_resolution (ネイティブ解像度 例: 480, 360)
  - vec2 u_canvasResolution (実際のCanvas解像度)
  - float u_pixelRatio (ピクセル比率)
  - float u_isSprite (スプライト描画時は1.0、全画面時は0.0)
  - vec2 u_spritePos (スプライト座標)
  - float u_spriteSize (スプライトサイズ%)
  - float u_spriteDirection (スプライトの向き)
  - vec4 u_spriteBounds (スプライト境界 left, bottom, right, top)

【シェーダーの参照コンテキストと対応ルール】
1. シェーダーが参照されていない場合（「現在エディタで開いているシェーダー」が提供されていない場合）：
   - ユーザーから「〇〇のシェーダーを作って」「新規作成」「水面エフェクト」など作成を依頼された場合:
     → ゼロから新しいシェーダーを設計し、完全なコードブロックを提供してください。
   - ユーザーから「現在のシェーダーを修正して」「このシェーダーについて教えて」「どこがおかしい？」「スピードを上げて」など、既存コードの参照を前提とした質問・修正依頼をされた場合:
     → 「現在シェーダーが参照されていません。シェーダーを編集・診断する場合は、左側の一覧またはエディタで対象のシェーダーを選択し、入力欄上部の『📎 参照する』ボタンが有効になっていることをご確認ください。」と丁寧に案内し、無関係なコードの推測編集は行わないでください。
2. シェーダーが参照されている場合：
   - 提供された【現在エディタで開いているシェーダー】または【統合シェーダー】のコードを基準に、修正・機能追加・解説を行ってください。

【統合シェーダー (Integrated Shader) の仕様と操作ルール】
- 統合シェーダーは、複数の「子シェーダー」を上から順番にピンポンバッファでマルチパス合成（後段のシェーダーが前段の描画結果を入力テクスチャ u_texture として受け取る）する高度な機能です。
- 「統合シェーダーを作って」「〇〇と△△を組み合わせた統合シェーダーを作成して」などと依頼された場合、または複数のエフェクトを順番に重ねるのが最適な場合:
  1. 回答の1行目に \`### 統合シェーダー名: [統合シェーダーの名前]\` を明記してください。
  2. 続けて、各子シェーダーを以下の形式で出力してください：
     \`\`\`markdown
     #### 子シェーダー: [子シェーダー1の名前]
     \`\`\`glsl
     // 子シェーダー1のコード
     \`\`\`
     
     #### 子シェーダー: [子シェーダー2の名前]
     \`\`\`glsl
     // 子シェーダー2のコード
     \`\`\`
     \`\`\`
- 既存の統合シェーダーを参照中に「〇〇の子シェーダーを追加して」と依頼された場合:
  - 追加する子シェーダーの名前を \`#### 子シェーダー: [名前]\` としてコードブロックを提供してください。

【最重要: 調整用パラメータの定義とScratchブロック連携ルール】
- 速度、強度、色、ブロック数、しきい値、サイズ、スケールなどの調整用パラメータは、**絶対にコード内に数値をハードコード（マジックナンバー）せず、シェーダー冒頭（トップレベル）で \`const float\` または \`uniform float\`（または \`const vec2/vec3/vec4\`, \`uniform vec2/vec3/vec4\`）として宣言すること**。
- 【重要】\`const float\` または \`uniform float\` で宣言された変数は、本TurboWarp拡張によって自動的に認識・抽出され、**ユーザーがScratchブロック（「変数を〇〇にする」「変数を〇〇ずつ変える」）からリアルタイムに自由に調整可能になります**。
- 例:
  \`\`\`glsl
  precision mediump float;
  uniform sampler2D u_texture;
  uniform float u_time;
  varying vec2 v_texCoord;

  // 調整用パラメータ (Scratchブロックから操作可能)
  const float SPEED = 2.0;       // アニメーション速度
  const float FREQUENCY = 10.0;  // 波の周波数
  const float STRENGTH = 0.02;   // 歪みの強さ
  \`\`\`
- 解説文の中でも、「\`SPEED\` や \`STRENGTH\` は \`const float\` で定義しているため、Scratch の変数操作ブロックから自由に数値を変更して調整できます」とユーザーに分かりやすく案内してください。

【コード提示時の重要ルール】
- シェーダーを新しく作成または修正する場合、回答の冒頭（1行目）に必ず「### シェーダー名: [シンプルで分かりやすい日本語名]」または「### 統合シェーダー名: [名前]」を明記してください（例: \`### シェーダー名: 水面の波紋\`、\`### 統合シェーダー名: シーンエフェクト\` など、2〜8文字程度の明瞭な名前）。
- シェーダーコードを作成・修正する場合は、必ず完全なコードをMarkdownのコードブロックで提供してください。
- Fragment Shaderのコードブロックには \`\`\`glsl または \`\`\`frag と明記してください。
- Vertex Shaderのコードブロックには \`\`\`vert と明記してください（省略時はパススルーとみなされます）。
- JavaScriptコード（アニメーションやUniform制御用）がある場合は \`\`\`javascript で記述してください。
- コードブロックの前後に、エフェクトの仕組みや修正点、使い方を日本語で親切かつ分かりやすく解説してください。
`.trim();

      // 現在開いているシェーダーのコンテキスト
      let contextMsg = '';
      if (currentData) {
        if (currentData.isIntegrated) {
          // 統合シェーダー全体
          contextMsg = `\n\n【現在開いている統合シェーダー (${currentData.name || '名称未設定'})】\n`;
          if (currentData.children && currentData.children.length > 0) {
            contextMsg += `内包する子シェーダー数: ${currentData.children.length}件\n`;
            currentData.children.forEach((c, i) => {
              const status = c.active ? '有効[ON]' : '無効[OFF]';
              contextMsg += `\n--- [子シェーダー ${i + 1}: ${c.name} (${status})] ---\n` +
                `[Fragment Shader]\n\`\`\`glsl\n${c.fragmentSource || ''}\n\`\`\`\n` +
                (c.vertexSource ? `[Vertex Shader]\n\`\`\`glsl\n${c.vertexSource}\n\`\`\`\n` : '') +
                (c.jsSource ? `[JavaScript]\n\`\`\`javascript\n${c.jsSource}\n\`\`\`\n` : '');
            });
          } else {
            contextMsg += `(子シェーダーはまだ登録されていません)\n`;
          }
        } else if (currentData.isChildShader) {
          // 統合シェーダーの子シェーダー単体
          contextMsg = `\n\n【現在編集中: 統合シェーダー「${currentData.parentName}」の子シェーダー「${currentData.name}」】\n` +
            `[Fragment Shader]\n\`\`\`glsl\n${currentData.fragmentSource || ''}\n\`\`\`\n` +
            `[Vertex Shader]\n\`\`\`glsl\n${currentData.vertexSource || ''}\n\`\`\`\n` +
            `[JavaScript]\n\`\`\`javascript\n${currentData.jsSource || ''}\n\`\`\``;
        } else if (currentData.fragmentSource || currentData.vertexSource) {
          // 単体シェーダー
          contextMsg = `\n\n【現在エディタで開いている単体シェーダー (${currentData.name || '名称未設定'})】\n` +
            `[Fragment Shader]\n\`\`\`glsl\n${currentData.fragmentSource || ''}\n\`\`\`\n` +
            `[Vertex Shader]\n\`\`\`glsl\n${currentData.vertexSource || ''}\n\`\`\`\n` +
            `[JavaScript]\n\`\`\`javascript\n${currentData.jsSource || ''}\n\`\`\``;
        }
      } else {
        contextMsg = `\n\n【現在エディタで開いているシェーダーはありません（参照解除中・新規作成モード）】`;
      }

      const formattedContents = messages.map((m, idx) => {
        let text = m.text;
        if (idx === messages.length - 1 && m.role === 'user' && contextMsg) {
          text += contextMsg;
        }
        return {
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: text }]
        };
      });

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
      const body = {
        contents: formattedContents,
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        throw new Error(`Gemini APIエラー: ${errMsg}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('Geminiから応答を受信できませんでした。');
      }
      return text;
    }

    async generateShader(userPrompt) {
      const systemPrompt = `
あなたはWebGL / GLSLシェーダーおよびTurboWarp拡張のエキスパートです。
ユーザーのリクエストに基づいて、TurboWarp用のGLSLシェーダーコードを生成してください。

【環境と仕様】
- WebGL 1.0 (GLSL ES 1.0)
- 組み込みUniform:
  - sampler2D u_texture (入力テクスチャ)
  - float u_time (秒単位の時間)
  - vec2 u_resolution (ネイティブ解像度 例: 480, 360)
  - vec2 u_canvasResolution (実際のCanvas解像度)
  - float u_pixelRatio (ピクセル比率)
  - float u_isSprite (スプライト描画時は1.0、全画面時は0.0)
  - vec2 u_spritePos (スプライト座標)
  - float u_spriteSize (スプライトサイズ%)
  - float u_spriteDirection (スプライトの向き)
  - vec4 u_spriteBounds (スプライトの境界 left, bottom, right, top)
- 【最重要】調整用パラメータ（速度、強度、色、しきい値等）は絶対にハードコードせず、\`const float\` または \`uniform float\`（または \`const vec2/vec3/vec4\`）で定義すること。これらはScratchブロックからユーザーが動的に変更・制御可能になります。
- 頂点シェーダーは通常パススルー（a_position, a_texCoord, v_texCoord）で構いません。

【出力フォーマット】
以下のJSONフォーマットのみを返してください（必ず \`\`\`json ... \`\`\` で囲んでください）:
\`\`\`json
{
  "name": "シェーダー名（日本語推奨）",
  "description": "シェーダーの特徴やエフェクトの解説（日本語。どの変数がブロックから操作できるかも記載）",
  "vertexShader": "attribute vec2 a_position;\\nattribute vec2 a_texCoord;\\nvarying vec2 v_texCoord;\\n\\nvoid main() {\\n  gl_Position = vec4(a_position, 0.0, 1.0);\\n  v_texCoord = a_texCoord;\\n}",
  "fragmentShader": "precision mediump float;\\nuniform sampler2D u_texture;\\nuniform float u_time;\\nvarying vec2 v_texCoord;\\n\\nconst float SPEED = 1.0;\\n\\nvoid main() {\\n  gl_FragColor = texture2D(u_texture, v_texCoord);\\n}",
  "jsCode": "// 初期化時に1回呼ばれる\\nfunction onInit(api) {\\n  \\n}\\n\\n// 毎フレーム呼ばれる\\nfunction onFrame(api) {\\n  \\n}"
}
\`\`\`
`.trim();

      const responseText = await this.generateContent(`【リクエスト】\n${userPrompt}`, systemPrompt);
      return this._parseJsonResponse(responseText);
    }

    async modifyShader(userPrompt, currentData) {
      const systemPrompt = `
あなたはWebGL / GLSLシェーダーのエキスパートです。
現在のシェーダーコードをユーザーの要望に従って修正・改良してください。
【最重要】調整パラメータはハードコードせず \`const float\` または \`uniform float\` で定義し、Scratchブロックから操作できるようにしてください。
必ず指定されたJSONフォーマットのみを返してください。
`.trim();

      const prompt = `
【現在のシェーダー】
名前: ${currentData.name || '名称未設定'}
Fragment Shader:
\`\`\`glsl
${currentData.fragmentSource || ''}
\`\`\`

Vertex Shader:
\`\`\`glsl
${currentData.vertexSource || ''}
\`\`\`

JavaScript:
\`\`\`javascript
${currentData.jsSource || ''}
\`\`\`

【修正リクエスト】
${userPrompt}

【出力フォーマット】
\`\`\`json
{
  "name": "${currentData.name || '修正後のシェーダー名'}",
  "description": "修正内容の説明（日本語）",
  "vertexShader": "修正後の頂点シェーダーコード",
  "fragmentShader": "修正後のフラグメントシェーダーコード",
  "jsCode": "修正後のJavaScriptコード"
}
\`\`\`
`.trim();

      const responseText = await this.generateContent(prompt, systemPrompt);
      return this._parseJsonResponse(responseText);
    }

    async fixShaderError(errorInfo, currentData) {
      const systemPrompt = `
あなたはGLSL / WebGLデバッグのエキスパートです。
発生しているコンパイルエラーまたは実行時エラーを分析し、修正した完全なシェーダーコードを提供してください。
【最重要】調整パラメータはハードコードせず \`const float\` または \`uniform float\` で定義してください。
必ず指定されたJSONフォーマットのみを返してください。
`.trim();

      const prompt = `
【発生したエラー】
${errorInfo}

【現在のシェーダーコード】
Fragment Shader:
\`\`\`glsl
${currentData.fragmentSource || ''}
\`\`\`

Vertex Shader:
\`\`\`glsl
${currentData.vertexSource || ''}
\`\`\`

JavaScript:
\`\`\`javascript
${currentData.jsSource || ''}
\`\`\`

【出力フォーマット】
\`\`\`json
{
  "name": "${currentData.name || '修復済みシェーダー'}",
  "description": "エラーの原因と修正内容の解説（日本語）",
  "vertexShader": "修復後の頂点シェーダーコード",
  "fragmentShader": "修復後のフラグメントシェーダーコード",
  "jsCode": "修復後のJavaScriptコード"
}
\`\`\`
`.trim();

      const responseText = await this.generateContent(prompt, systemPrompt);
      return this._parseJsonResponse(responseText);
    }

    async explainShader(currentData) {
      const systemPrompt = `
あなたはWebGL / GLSLシェーダーの教育のエキスパートです。
提示されたシェーダーコードのアルゴリズム、数式、色の計算ロジック、各Uniform変数の役割などを、初心者〜中級者にも分かりやすく親切に日本語で解説してください。
Markdown形式で分かりやすく整理して出力してください。
`.trim();

      const prompt = `
以下のシェーダーコードを解説してください。

名前: ${currentData.name || '名称未設定'}

Fragment Shader:
\`\`\`glsl
${currentData.fragmentSource || ''}
\`\`\`

Vertex Shader:
\`\`\`glsl
${currentData.vertexSource || ''}
\`\`\`

JavaScript:
\`\`\`javascript
${currentData.jsSource || ''}
\`\`\`
`.trim();

      return await this.generateContent(prompt, systemPrompt);
    }

    _parseJsonResponse(text) {
      let jsonStr = text.trim();
      const match = jsonStr.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
      if (match) {
        jsonStr = match[1].trim();
      }
      try {
        return JSON.parse(jsonStr);
      } catch (err) {
        console.warn('[GeminiService] JSON parse error:', err, text);
        throw new Error('Geminiの出力をJSONとして解析できませんでした。もう一度お試しください。');
      }
    }
  }

  class ShaderEditor {
    constructor(shaderManager) {
      this.shaderManager = shaderManager;
      this.gemini = new GeminiService();
      this.currentShader = null;
      this.collapsedIntegrated = new Set();
      this._isNewShaderPending = false;
      this._lastCompilationError = null;
      this.uiMode = localStorage.getItem('se_ui_mode') || 'ide'; // 'ide' | 'chat'
      this.isSideEditorOpenInChatMode = false;
      this.isAIPanelOpen = true; // デフォルトでAIパネルを表示（IDE統合）
      this.autoApply = localStorage.getItem('se_auto_apply') !== 'false'; // デフォルトで自動適用有効
      this.isContextIgnored = false;
      this.chatMessages = [];
      this._hasFetchedModels = false;
      this._buildUI();
      this._setupDragAndDrop();
      this._loadFonts();
      this._loadMaterialIcons();
      this._loadPrism().then(() => {
        if (this.fragmentPanel) this.fragmentPanel.updateHighlight();
        if (this.vertexPanel) this.vertexPanel.updateHighlight();
        if (this.jsPanel) this.jsPanel.updateHighlight();
      });
    }

    _buildUI() {
      this.container = document.createElement('div');
      this.container.id = 'glsl-shader-studio-overlay-root';
      this.container.className = 'se-container';
      Object.assign(this.container.style, {
        display: 'none', position: 'fixed', inset: '0',
        width: '100vw', height: '100vh',
        background: 'var(--se-bg-primary)',
        zIndex: '100005', fontFamily: 'var(--se-font-ui)'
      });

      const win = document.createElement('div');
      win.className = 'se-window';
      Object.assign(win.style, {
        position: 'absolute', inset: '0',
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: 'var(--se-bg-primary)'
      });

      // 1. トップヘッダー (フルスクリーンバー)
      const header = this._makeEl('div', {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 24px', background: 'var(--se-bg-secondary)',
        borderBottom: '1px solid var(--se-border)', flexShrink: '0', height: '52px', boxSizing: 'border-box'
      });
      
      const titleGroup = this._makeEl('div', { display: 'flex', alignItems: 'center', gap: '14px' });
      
      const btnToggleSidebar = this._makeEl('button', {
        background: 'transparent', border: 'none', color: 'var(--se-text-secondary)',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '6px', borderRadius: 'var(--se-radius-sm)', transition: 'var(--se-transition)'
      });
      btnToggleSidebar.title = 'サイドバーを表示/非表示';
      const toggleIcon = this._makeEl('span', { fontSize: '18px', lineHeight: '1' });
      toggleIcon.textContent = '☰';
      btnToggleSidebar.appendChild(toggleIcon);
      btnToggleSidebar.onmouseenter = () => { btnToggleSidebar.style.background = 'var(--se-bg-hover)'; btnToggleSidebar.style.color = 'var(--se-text-primary)'; };
      btnToggleSidebar.onmouseleave = () => { btnToggleSidebar.style.background = 'transparent'; btnToggleSidebar.style.color = 'var(--se-text-secondary)'; };
      btnToggleSidebar.onclick = () => {
        const isHidden = this.sidebar.style.display === 'none';
        this.sidebar.style.display = isHidden ? 'flex' : 'none';
      };

      const logoIcon = this._makeEl('span', {
        width: '32px', height: '32px', borderRadius: '8px', background: 'var(--se-accent-gradient)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '18px',
        boxShadow: '0 2px 10px rgba(124,108,240,0.3)'
      });
      logoIcon.textContent = '✨';
      const logoText = this._makeEl('div', { fontSize: '17px', fontWeight: '800', letterSpacing: '-0.3px' });
      const logoGradient = this._makeEl('span', { background: 'var(--se-accent-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' });
      logoGradient.textContent = 'Shader Studio';
      logoText.appendChild(logoGradient);

      titleGroup.appendChild(btnToggleSidebar);
      titleGroup.appendChild(logoIcon);
      titleGroup.appendChild(logoText);

      const headerActions = this._makeEl('div', { display: 'flex', gap: '8px', alignItems: 'center' });
      
      // UIモード切替ボタン (IDEモード / Cursor風対話メイン)
      this.btnToggleUIMode = this._makeEl('button', { className: 'se-mode-badge' });
      this.btnToggleUIMode.onclick = () => this._toggleUIMode();
      this._updateUIModeButton();

      // モデル選択ピル (ChatGPT風)
      this.btnModelBadge = this._makeEl('button', {
        background: 'rgba(124,108,240,0.12)', border: '1px solid rgba(124,108,240,0.3)',
        borderRadius: '20px', color: 'var(--se-text-primary)', fontSize: '12px', fontWeight: '600',
        padding: '5px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
        transition: 'var(--se-transition)'
      });
      this.btnModelBadge.onclick = () => this._showSettingsModal();
      this._updateModelBadge();

      // 新規チャットボタン
      const btnNewChat = this._makeEl('button', {
        background: 'transparent', border: '1px solid var(--se-border)', color: 'var(--se-text-secondary)',
        borderRadius: 'var(--se-radius-sm)', padding: '5px 10px', fontSize: '12px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: '4px', transition: 'var(--se-transition)'
      });
      btnNewChat.title = '新しいチャットを開始 (会話リセット)';
      btnNewChat.textContent = '✏️ 新規';
      btnNewChat.onmouseenter = () => { btnNewChat.style.borderColor = 'var(--se-accent)'; btnNewChat.style.color = 'var(--se-text-primary)'; };
      btnNewChat.onmouseleave = () => { btnNewChat.style.borderColor = 'var(--se-border)'; btnNewChat.style.color = 'var(--se-text-secondary)'; };
      btnNewChat.onclick = () => this._startNewChat();

      // 設定ボタン
      const btnSettings = this._makeEl('button', {
        background: 'transparent', border: '1px solid var(--se-border)', color: 'var(--se-text-secondary)',
        borderRadius: 'var(--se-radius-sm)', padding: '5px 8px', fontSize: '14px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'var(--se-transition)'
      });
      btnSettings.title = 'Gemini API・モデル設定';
      btnSettings.textContent = '⚙️';
      btnSettings.onmouseenter = () => { btnSettings.style.borderColor = 'var(--se-accent)'; btnSettings.style.color = 'var(--se-text-primary)'; };
      btnSettings.onmouseleave = () => { btnSettings.style.borderColor = 'var(--se-border)'; btnSettings.style.color = 'var(--se-text-secondary)'; };
      btnSettings.onclick = () => this._showSettingsModal();

      const btnClose = this._createBtn('閉じる', 'var(--se-bg-tertiary)', () => this.hide(), 'close');
      btnClose.style.padding = '6px 12px';
      btnClose.style.fontSize = '12px';

      headerActions.appendChild(this.btnToggleUIMode);
      headerActions.appendChild(this.btnModelBadge);
      headerActions.appendChild(btnNewChat);
      headerActions.appendChild(btnSettings);
      headerActions.appendChild(btnClose);
      header.appendChild(titleGroup);
      header.appendChild(headerActions);

      // 2. メインコンテナ (左サイドバー | 中央エディタ | 右AIパネル)
      const main = this._makeEl('div', { flex: '1', display: 'flex', overflow: 'hidden', position: 'relative', minHeight: '0' });

      // [左カラム] サイドバー（シェーダー一覧）
      this.sidebar = this._makeEl('div', {
        width: '280px', flexShrink: '0', display: 'flex', flexDirection: 'column',
        background: 'var(--se-bg-secondary)', borderRight: '1px solid var(--se-border)',
        overflow: 'hidden'
      });

      const sideHeader = this._makeEl('div', {
        padding: '12px 14px', borderBottom: '1px solid var(--se-border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px'
      });
      const sideTitle = this._makeEl('span', { fontSize: '12px', fontWeight: '700', color: 'var(--se-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.8px' });
      sideTitle.textContent = 'シェーダー一覧';

      const sideHeaderActions = this._makeEl('div', { display: 'flex', gap: '4px', alignItems: 'center' });
      
      const btnNewShader = this._createBtn('＋ 新規', 'var(--se-accent)', (e) => this._showNewShaderMenu(e));
      btnNewShader.title = '新規シェーダー作成';
      btnNewShader.style.padding = '4px 8px';
      btnNewShader.style.fontSize = '11.5px';

      const btnImportTop = this._createBtn('↘ 読込', 'var(--se-bg-tertiary)', (e) => this._showImportMenu(e));
      btnImportTop.title = 'シェーダーをインポート';
      btnImportTop.style.padding = '4px 8px';
      btnImportTop.style.fontSize = '11.5px';

      const btnExportTop = this._createBtn('↗ 出力', 'var(--se-bg-tertiary)', (e) => this._showExportMenu(e));
      btnExportTop.title = 'シェーダーをエクスポート';
      btnExportTop.style.padding = '4px 8px';
      btnExportTop.style.fontSize = '11.5px';

      sideHeaderActions.appendChild(btnNewShader);
      sideHeaderActions.appendChild(btnImportTop);
      sideHeaderActions.appendChild(btnExportTop);

      sideHeader.appendChild(sideTitle);
      sideHeader.appendChild(sideHeaderActions);

      this.shaderList = document.createElement('ul');
      Object.assign(this.shaderList.style, { flex: '1', padding: '12px', margin: '0', listStyle: 'none', overflowY: 'auto' });

      const sideFooter = this._makeEl('div', {
        padding: '10px 16px', borderTop: '1px solid var(--se-border)', background: 'var(--se-bg-primary)',
        display: 'flex', gap: '8px'
      });
      const btnExportAll = this._createBtn('エクスポート', 'var(--se-bg-tertiary)', (e) => this._showExportMenu(e), 'upload');
      btnExportAll.style.flex = '1';
      btnExportAll.style.fontSize = '11px';
      btnExportAll.style.padding = '6px';
      btnExportAll.style.justifyContent = 'center';
      const btnImportAll = this._createBtn('インポート', 'var(--se-bg-tertiary)', (e) => this._showImportMenu(e), 'download');
      btnImportAll.style.flex = '1';
      btnImportAll.style.fontSize = '11px';
      btnImportAll.style.padding = '6px';
      btnImportAll.style.justifyContent = 'center';
      sideFooter.appendChild(btnExportAll);
      sideFooter.appendChild(btnImportAll);

      this.sidebar.appendChild(sideHeader);
      this.sidebar.appendChild(this.shaderList);
      this.sidebar.appendChild(sideFooter);

      // [中央カラム] エディタコンテナ
      this.editorContainer = this._makeEl('div', { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden' });

      // エディタ上部ツールバー
      const editorToolbar = this._makeEl('div', {
        padding: '10px 24px', background: 'var(--se-bg-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--se-border)', gap: '16px', flexShrink: '0', height: '56px', boxSizing: 'border-box'
      });

      const toolLeft = this._makeEl('div', { display: 'flex', alignItems: 'center', gap: '12px', flex: '1', minWidth: '0' });
      this.modeBadge = this._makeEl('span', {
        padding: '4px 10px', borderRadius: '4px', fontSize: '11px', fontWeight: '700',
        letterSpacing: '0.6px', display: 'none'
      });
      this.nameInput = document.createElement('input');
      this.nameInput.className = 'se-input';
      Object.assign(this.nameInput.style, { width: '240px', fontSize: '14px', fontWeight: '700', padding: '6px 12px' });
      this.nameInput.placeholder = 'シェーダー名...';
      this.nameInput.addEventListener('change', () => this._onNameInputConfirm());

      this.btnCreate = this._createBtn('作成', 'var(--se-success)', () => this._onNameInputConfirm(), 'check');
      this.btnCreate.style.padding = '6px 14px';
      this.btnCancel = this._createBtn('キャンセル', 'var(--se-error)', () => this._cancelNewShaderCreation(), 'close');
      this.btnCancel.style.padding = '6px 14px';

      toolLeft.appendChild(this.modeBadge);
      toolLeft.appendChild(this.nameInput);
      toolLeft.appendChild(this.btnCreate);
      toolLeft.appendChild(this.btnCancel);

      const toolRight = this._makeEl('div', { display: 'flex', alignItems: 'center', gap: '12px' });
      this.tabBar = this._makeEl('div', { display: 'flex', gap: '4px', background: 'var(--se-bg-secondary)', borderRadius: 'var(--se-radius-sm)', padding: '3px' });
      this.tabBar.className = 'se-tab-bar';

      this.tabSplit = this._createTabBtn('splitscreen', '分割表示', '#a29bfe');
      this.tabFrag = this._createTabBtn('code', 'Fragment', '#fdcb6e');
      this.tabVert = this._createTabBtn('change_history', 'Vertex', '#00cec9');
      this.tabJs = this._createTabBtn('javascript', 'JavaScript', '#ffeaa7');

      const selectTab = (activeTab) => {
        [this.tabSplit, this.tabFrag, this.tabVert, this.tabJs].forEach(t => t.classList.remove('active'));
        activeTab.classList.add('active');
        this.fragmentPanel.container.style.display = 'none';
        this.vertexPanel.container.style.display = 'none';
        this.jsPanel.container.style.display = 'none';
        
        if (activeTab === this.tabSplit) {
          this.fragmentPanel.container.style.display = 'flex';
          this.vertexPanel.container.style.display = 'flex';
        } else if (activeTab === this.tabFrag) {
          this.fragmentPanel.container.style.display = 'flex';
        } else if (activeTab === this.tabVert) {
          this.vertexPanel.container.style.display = 'flex';
        } else if (activeTab === this.tabJs) {
          this.jsPanel.container.style.display = 'flex';
        }
      };

      this.tabSplit.addEventListener('click', () => selectTab(this.tabSplit));
      this.tabFrag.addEventListener('click', () => selectTab(this.tabFrag));
      this.tabVert.addEventListener('click', () => selectTab(this.tabVert));
      this.tabJs.addEventListener('click', () => selectTab(this.tabJs));

      [this.tabSplit, this.tabFrag, this.tabVert, this.tabJs].forEach(t => this.tabBar.appendChild(t));

      this.btnExportCurrent = this._createBtn('↗ 出力', 'var(--se-bg-secondary)', (e) => this._showExportMenu(e));
      this.btnExportCurrent.title = '現在のシェーダーをエクスポート';
      this.btnExportCurrent.style.padding = '5px 10px';
      this.btnExportCurrent.style.fontSize = '12px';

      this.btnDel = this._createBtn('', 'rgba(255,107,107,0.15)', () => this._deleteShader(), 'delete');
      this.btnDel.style.color = 'var(--se-error)';
      this.btnDel.style.padding = '6px 10px';
      this.btnDel.title = 'このシェーダーを削除';

      toolRight.appendChild(this.tabBar);
      toolRight.appendChild(this.btnExportCurrent);
      toolRight.appendChild(this.btnDel);

      editorToolbar.appendChild(toolLeft);
      editorToolbar.appendChild(toolRight);

      // コードエディタ領域
      this.editorArea = this._makeEl('div', { flex: '1', display: 'flex', overflow: 'hidden', minHeight: '0' });
      this.fragmentPanel = this._createEditorPanel('Fragment Shader (ピクセル処理)', 'glsl');
      this.vertexPanel = this._createEditorPanel('Vertex Shader (頂点処理)', 'glsl');
      this.jsPanel = this._createEditorPanel('JavaScript (動的制御)', 'javascript');
      this.fragmentEditor = this.fragmentPanel.textarea;
      this.vertexEditor = this.vertexPanel.textarea;
      this.jsEditor = this.jsPanel.textarea;
      
      this.editorArea.appendChild(this.fragmentPanel.container);
      this.editorArea.appendChild(this.vertexPanel.container);
      this.editorArea.appendChild(this.jsPanel.container);

      this.editorContainer.appendChild(editorToolbar);
      this.editorContainer.appendChild(this.editorArea);

      // 統合シェーダーマネージャ領域
      this.integratedArea = this._makeEl('div', { flex: '1', display: 'none', flexDirection: 'column', padding: '32px 48px', overflowY: 'auto' });
      this._buildIntegratedManagerUI();

      // 空状態領域
      this.emptyStateArea = this._makeEl('div', { flex: '1', display: 'none', alignItems: 'center', justifyContent: 'center', background: 'var(--se-bg-primary)', padding: '40px' });
      const emptyCard = this._makeEl('div', {
        width: '100%', maxWidth: '680px', padding: '48px 40px', background: 'var(--se-bg-secondary)',
        borderRadius: 'var(--se-radius)', border: '1px solid var(--se-border)', boxShadow: 'var(--se-shadow)',
        textAlign: 'center'
      });
      const cIcon = this._makeEl('div', { fontSize: '48px', marginBottom: '16px' }); cIcon.textContent = '✨';
      const cTitle = this._makeEl('h2', { margin: '0 0 10px 0', fontSize: '24px', fontWeight: '800', color: 'var(--se-text-primary)' });
      cTitle.textContent = 'GLSL Shader Studio';
      const cSub = this._makeEl('p', { margin: '0 0 32px 0', color: 'var(--se-text-secondary)', fontSize: '14px', lineHeight: '1.6' });
      cSub.textContent = '左側のリストからシェーダーを選択するか、新規作成・Gemini AIで生成してください。';
      
      const primaryActions = this._makeEl('div', { display: 'flex', gap: '14px', justifyContent: 'center', marginBottom: '32px' });
      const btnNewAIGen = this._createBtn('Gemini AIで生成', 'linear-gradient(135deg, #7c6cf0, #e056fd)', () => this._openAIGenerator(), 'auto_awesome');
      btnNewAIGen.style.padding = '12px 24px';
      btnNewAIGen.style.fontSize = '14px';
      btnNewAIGen.style.boxShadow = '0 4px 16px rgba(124,108,240,0.4)';
      const btnNewSingle = this._createBtn('単体作成', 'var(--se-accent)', () => this._newShader(), 'add');
      btnNewSingle.style.padding = '12px 24px';
      btnNewSingle.style.fontSize = '14px';
      const btnNewIntegrated = this._createBtn('統合作成', 'var(--se-bg-tertiary)', () => this._newIntegratedShader(), 'account_tree');
      btnNewIntegrated.style.padding = '12px 24px';
      btnNewIntegrated.style.fontSize = '14px';
      primaryActions.appendChild(btnNewAIGen);
      primaryActions.appendChild(btnNewSingle);
      primaryActions.appendChild(btnNewIntegrated);

      const tplHeader = this._makeEl('div', { fontSize: '12px', fontWeight: '700', color: 'var(--se-text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '14px' });
      tplHeader.textContent = 'サンプルテンプレート';
      const tplActions = this._makeEl('div', { display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' });
      const btnTplWave = this._createBtn('波エフェクト', 'var(--se-bg-tertiary)', () => this._createSampleShader('波エフェクト', 'wave'), 'water');
      btnTplWave.style.padding = '8px 16px';
      const btnTplMosaic = this._createBtn('モザイク', 'var(--se-bg-tertiary)', () => this._createSampleShader('モザイク', 'mosaic'), 'grid_view');
      btnTplMosaic.style.padding = '8px 16px';
      const btnTplInvert = this._createBtn('色反転', 'var(--se-bg-tertiary)', () => this._createSampleShader('色反転', 'invert'), 'invert_colors');
      btnTplInvert.style.padding = '8px 16px';
      const btnTplOutline = this._createBtn('枠線 (スプライト)', 'var(--se-bg-tertiary)', () => this._createSampleShader('スプライト枠線', 'outline'), 'crop_square');
      btnTplOutline.style.padding = '8px 16px';
      tplActions.appendChild(btnTplWave);
      tplActions.appendChild(btnTplMosaic);
      tplActions.appendChild(btnTplInvert);
      tplActions.appendChild(btnTplOutline);

      emptyCard.appendChild(cIcon);
      emptyCard.appendChild(cTitle);
      emptyCard.appendChild(cSub);
      emptyCard.appendChild(primaryActions);
      emptyCard.appendChild(tplHeader);
      emptyCard.appendChild(tplActions);
      this.emptyStateArea.appendChild(emptyCard);

      // [中央カラム] センターワークスペース (エディタ群 / 統合マネージャ / 空状態を内包)
      this.centerArea = this._makeEl('div', {
        flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', position: 'relative'
      });
      this.centerArea.appendChild(this.editorContainer);
      this.centerArea.appendChild(this.integratedArea);
      this.centerArea.appendChild(this.emptyStateArea);

      // [右カラム] AI パネル
      this._buildAIPanelUI();

      // メインに各カラムを追加 (サイドバー | センターワークスペース | AIパネル)
      main.appendChild(this.sidebar);
      main.appendChild(this.centerArea);
      main.appendChild(this.aiPanel);

      // 3. ボトムステータスバー
      this.statusBar = this._makeEl('div', {
        padding: '8px 24px', background: 'var(--se-bg-secondary)', borderTop: '1px solid var(--se-border)',
        fontSize: '12px', color: 'var(--se-text-secondary)', display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', flexShrink: '0', height: '36px', boxSizing: 'border-box'
      });
      this.statusLang = this._makeEl('span', { fontWeight: '700', color: 'var(--se-accent-2)' });
      this.statusMsg = this._makeEl('span', {});
      this.statusBar.appendChild(this.statusLang);
      this.statusBar.appendChild(this.statusMsg);
      this.statusMsg.textContent = '準備完了';

      win.appendChild(header);
      win.appendChild(main);
      win.appendChild(this.statusBar);
      this.container.appendChild(win);
      document.body.appendChild(this.container);

      this.toastContainer = this._makeEl('div', { position: 'fixed', bottom: '32px', right: '32px', zIndex: '10002', display: 'flex', flexDirection: 'column', gap: '10px' });
      document.body.appendChild(this.toastContainer);

      this.vertexEditor.value = `attribute vec2 a_position;\nattribute vec2 a_texCoord;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_Position = vec4(a_position, 0.0, 1.0);\n  v_texCoord = a_texCoord;\n}`;
      this.fragmentEditor.value = `precision mediump float;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_FragColor = texture2D(u_texture, v_texCoord);\n}`;
      this.jsEditor.value = `// 初期化時に1回呼ばれる\nfunction onInit(api) {\n  \n}\n\n// 毎フレーム呼ばれる\nfunction onFrame(api) {\n  \n}`;

      this._updateList();
      this._showEmptyState('シェーダーを選択してください');
    }

    _makeEl(tag, styles) {
      const el = document.createElement(tag);
      if (styles) {
        if (styles.className) {
          el.className = styles.className;
          const s = Object.assign({}, styles);
          delete s.className;
          Object.assign(el.style, s);
        } else {
          Object.assign(el.style, styles);
        }
      }
      return el;
    }

    _getIconSymbol(name) {
      const ICON_MAP = {
        'menu_open': '☰',
        'menu': '☰',
        'auto_awesome': '✨',
        'close': '✕',
        'add': '＋',
        'upload': '↗',
        'download': '↘',
        'check': '✓',
        'splitscreen': '◫',
        'code': '◆',
        'change_history': '▲',
        'javascript': 'JS',
        'delete': '🗑',
        'water': '🌊',
        'grid_view': '▦',
        'invert_colors': '◐',
        'crop_square': '▢',
        'account_tree': '☊',
        'add_circle': '＋',
        'edit': '✎',
        'edit_note': '✎',
        'build': '🛠',
        'build_circle': '🛠',
        'psychology': '💡',
        'settings': '⚙',
        'save': '💾',
        'folder': '📁',
        'description': '📄',
        'segment': '└'
      };
      return ICON_MAP[name] || name;
    }

    _createBtn(text, bg, onClick, iconName = null) {
      const btn = document.createElement('button');
      btn.className = 'se-btn';
      btn.style.background = bg;
      if (iconName) {
        const symbol = this._getIconSymbol(iconName);
        const iEl = this._makeEl('span', { fontSize: '14px', lineHeight: '1', display: 'inline-block' });
        iEl.textContent = symbol;
        btn.appendChild(iEl);
        if (text) btn.appendChild(document.createTextNode(text));
      } else {
        btn.textContent = text;
      }
      btn.addEventListener('click', onClick);
      return btn;
    }

    _createTabBtn(icon, text, color) {
      const btn = document.createElement('button');
      btn.className = 'se-tab-btn';
      const symbol = this._getIconSymbol(icon);
      const iEl = this._makeEl('span', { fontSize: '13px', color: color, fontWeight: '700' });
      iEl.textContent = symbol;
      btn.appendChild(iEl);
      btn.appendChild(document.createTextNode(text));
      return btn;
    }

    _createToggle(initialChecked, onChange) {
      const label = document.createElement('label');
      label.className = 'se-toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(initialChecked);
      const slider = document.createElement('span');
      slider.className = 'se-toggle-slider';
      input.addEventListener('change', () => {
        if (onChange) onChange(input.checked);
      });
      label.appendChild(input);
      label.appendChild(slider);
      return label;
    }

    _showToast(msg, isError = false) {
      const toast = this._makeEl('div', {
        background: isError ? 'var(--se-error)' : 'var(--se-success)',
        color: '#fff', padding: '10px 16px', borderRadius: 'var(--se-radius-sm)',
        fontSize: '13px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        opacity: '0', transform: 'translateY(10px)', transition: 'var(--se-transition)'
      });
      toast.textContent = msg;
      this.toastContainer.appendChild(toast);
      requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
      });
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 250);
      }, 3000);
    }

    _setStatus(msg) { this.statusMsg.textContent = msg; }
    _setLang(lang) { this.statusLang.textContent = lang; }

    _showEmptyState(statusMsg) {
      this.editorContainer.style.display = 'none';
      this.editorArea.style.display = 'none';
      this.integratedArea.style.display = 'none';
      this.emptyStateArea.style.display = 'flex';
      this.currentShader = null;
      this.currentChildShaderParent = null;
      this.currentChildShaderName = null;
      this._isNewShaderPending = false;
      this.nameInput.value = '';
      this._clearEditorErrors();
      if (statusMsg) this._setStatus(statusMsg);
      this._updateList();
      this._updateModeUI();
      this._setLang('');
      this._updateAIContextBadge();
    }

    _showCodeEditors() {
      this.emptyStateArea.style.display = 'none';
      this.integratedArea.style.display = 'none';
      this.editorContainer.style.display = 'flex';
      this.editorArea.style.display = 'flex';
      this.tabSplit.click();
      this._setLang('GLSL / JS');
      this._updateAIContextBadge();
    }

    _showIntegratedEditor() {
      this.emptyStateArea.style.display = 'none';
      this.editorContainer.style.display = 'none';
      this.integratedArea.style.display = 'flex';
      this._setLang('Integrated');
      this._updateAIContextBadge();
    }

    _createEditorPanel(title, lang) {
      const container = this._makeEl('div', { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--se-border)' });
      const header = this._makeEl('div', {
        padding: '8px 18px', background: 'var(--se-bg-tertiary)', borderBottom: '1px solid var(--se-border)',
        fontSize: '12px', fontWeight: '600', color: 'var(--se-text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center'
      });
      const headerTitle = this._makeEl('span', {}); headerTitle.textContent = title;
      const langBadge = this._makeEl('span', {
        fontSize: '10px', padding: '2px 8px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)',
        color: 'var(--se-text-muted)', textTransform: 'uppercase', fontWeight: '700', letterSpacing: '0.5px'
      });
      langBadge.textContent = lang;
      header.appendChild(headerTitle);
      header.appendChild(langBadge);

      const editorWrapper = this._makeEl('div', { flex: '1', position: 'relative', overflow: 'hidden', background: 'var(--se-bg-editor)' });
      const fontStyles = { fontFamily: 'var(--se-font-code)', fontSize: '14px', lineHeight: '1.7', tabSize: '2' };
      
      const pre = document.createElement('pre');
      Object.assign(pre.style, { margin: '0', position: 'absolute', inset: '0', padding: '18px 22px', boxSizing: 'border-box', pointerEvents: 'none', overflow: 'hidden', whiteSpace: 'pre', ...fontStyles });
      const code = document.createElement('code');
      code.className = `language-${lang} shader-editor-code`;
      Object.assign(code.style, fontStyles);
      pre.appendChild(code);

      const textarea = document.createElement('textarea');
      Object.assign(textarea.style, { margin: '0', position: 'absolute', inset: '0', padding: '18px 22px', boxSizing: 'border-box', background: 'transparent', color: 'transparent', caretColor: '#fff', border: 'none', resize: 'none', outline: 'none', overflow: 'auto', whiteSpace: 'pre', ...fontStyles });
      textarea.spellcheck = false;
      textarea.wrap = 'off';

      textarea.addEventListener('scroll', () => { pre.scrollTop = textarea.scrollTop; pre.scrollLeft = textarea.scrollLeft; });
      const updateHighlight = () => {
        code.textContent = textarea.value;
        if (window.Prism) Prism.highlightElement(code);
      };

      const pairs = { '{':'}', '[':']', '(':')', '"':'"', "'":"'" };
      textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this._saveShader(); return; }
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const val = textarea.value;

        if (pairs[e.key]) {
          e.preventDefault();
          const insert = e.key + pairs[e.key];
          document.execCommand('insertText', false, insert);
          textarea.selectionStart = textarea.selectionEnd = start + 1;
          updateHighlight();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          document.execCommand('insertText', false, '  ');
          updateHighlight();
        } else if (e.key === 'Enter') {
          const currentLine = val.substring(0, start).split('\n').pop();
          const match = currentLine.match(/^(\s*)/);
          if (match) {
            e.preventDefault();
            let indent = match[0];
            const prevChar = val.charAt(start - 1);
            const nextChar = val.charAt(start);
            if (prevChar === '{') {
              const newIndent = indent + '  ';
              if (nextChar === '}') {
                document.execCommand('insertText', false, '\n' + newIndent + '\n' + indent);
                textarea.selectionStart = textarea.selectionEnd = start + newIndent.length + 1;
              } else {
                document.execCommand('insertText', false, '\n' + newIndent);
              }
            } else {
              document.execCommand('insertText', false, '\n' + indent);
            }
            updateHighlight();
          }
        }
      });
      textarea.addEventListener('input', () => { updateHighlight(); this._autoSaveShader(); });

      const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      Object.defineProperty(textarea, 'value', {
        get: () => originalDescriptor.get.call(textarea),
        set: (val) => { originalDescriptor.set.call(textarea, val); updateHighlight(); }
      });

      editorWrapper.appendChild(pre);
      editorWrapper.appendChild(textarea);
      
      const errorPanel = this._makeEl('div', { background: 'rgba(255,107,107,0.1)', color: 'var(--se-error)', fontSize: '12px', maxHeight: '0', overflow: 'hidden', padding: '0', transition: 'var(--se-transition)', whiteSpace: 'pre-wrap' });
      container.appendChild(header);
      container.appendChild(editorWrapper);
      container.appendChild(errorPanel);

      return { container, textarea, updateHighlight, errorPanel };
    }

    _buildIntegratedManagerUI() {
      this.integratedChildrenList = document.createElement('ul');
      Object.assign(this.integratedChildrenList.style, { listStyle: 'none', padding: '0', margin: '15px 0 0 0' });

      let dragItem = null;
      this.integratedChildrenList.addEventListener('dragstart', e => {
        const li = e.target.closest('li');
        if(!li) return;
        dragItem = li;
        e.dataTransfer.effectAllowed = 'move';
        li.style.opacity = '0.5';
      });
      this.integratedChildrenList.addEventListener('dragend', e => {
        if(dragItem) dragItem.style.opacity = '1';
        dragItem = null;
      });
      this.integratedChildrenList.addEventListener('dragover', e => {
        e.preventDefault();
        const li = e.target.closest('li');
        if(li && li !== dragItem && dragItem) {
          const rect = li.getBoundingClientRect();
          const next = (e.clientY - rect.top)/(rect.bottom - rect.top) > 0.5;
          this.integratedChildrenList.insertBefore(dragItem, next ? li.nextSibling : li);
        }
      });
      this.integratedChildrenList.addEventListener('drop', e => {
        e.preventDefault();
        if(!dragItem || !this.currentShader) return;
        dragItem.style.opacity = '1';
        const shader = this.shaderManager.getShader(this.currentShader);
        if(!shader || !shader.isIntegrated) return;
        
        const newOrderNames = Array.from(this.integratedChildrenList.children).map(li => li.dataset.childName);
        const newChildren = newOrderNames.map(n => shader.children.find(c => c.name === n));
        shader.children = newChildren;
        shader.activeChildren = newOrderNames.filter(n => {
           const li = Array.from(this.integratedChildrenList.children).find(x => x.dataset.childName === n);
           return li && li.querySelector('input').checked;
        });
        
        this.shaderManager.saveShadersToProject();
        this.shaderManager.isDirty = true;
        this._updateList();
      });

      const desc = this._makeEl('div', { color: 'var(--se-text-secondary)', fontSize: '13px', marginBottom: '15px' });
      desc.textContent = '統合シェーダー: 複数の子シェーダーを組み合わせて適用します。';
      const btnAdd = this._createBtn('子シェーダー追加', 'var(--se-accent)', () => {
        const name = prompt('子シェーダー名:');
        if (!name) return;
        const shader = this.shaderManager.getShader(this.currentShader);
        if (!shader || !shader.isIntegrated) return;
        if (shader.children.some(c => c.name === name)) return alert('同名が存在します');
        const defaultV = `attribute vec2 a_position;\nattribute vec2 a_texCoord;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_Position = vec4(a_position, 0.0, 1.0);\n  v_texCoord = a_texCoord;\n}`;
        const defaultF = `precision mediump float;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_FragColor = texture2D(u_texture, v_texCoord);\n}`;
        let progData = { program: null, uniforms: {} };
        try { progData = this.shaderManager.createProgram(defaultV, defaultF); } catch(e){}
        shader.children.push({
          name, vertexSource: defaultV, fragmentSource: defaultF, jsSource: '', ...progData, uniformValues: {}, isIntegrated: false, children: [], activeChildren: []
        });
        if (!shader.activeChildren) shader.activeChildren = [];
        shader.activeChildren.push(name);
        this.shaderManager.saveShadersToProject();
        this._updateIntegratedList();
        this._updateList();
      });
      
      this.integratedArea.appendChild(desc);
      this.integratedArea.appendChild(btnAdd);
      this.integratedArea.appendChild(this.integratedChildrenList);
    }

    _updateIntegratedList() {
      this.integratedChildrenList.replaceChildren();
      const shader = this.shaderManager.getShader(this.currentShader);
      if (!shader || !shader.isIntegrated) return;
      shader.children.forEach(c => {
        const li = this._makeEl('li', {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px', background: 'var(--se-bg-tertiary)',
          marginBottom: '8px', borderRadius: 'var(--se-radius-sm)', border: '1px solid var(--se-border)', cursor: 'grab'
        });
        li.draggable = true;
        li.dataset.childName = c.name;

        const left = this._makeEl('div', { display: 'flex', alignItems: 'center', gap: '10px' });
        const icon = this._makeEl('span', { className: 'material-symbols-outlined', fontSize: '18px', color: 'var(--se-text-secondary)', cursor: 'grab' }); icon.textContent = 'drag_indicator';
        
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = shader.activeChildren && shader.activeChildren.includes(c.name);
        cb.onchange = (e) => {
           if(e.target.checked) { if(!shader.activeChildren.includes(c.name)) shader.activeChildren.push(c.name); }
           else { shader.activeChildren = shader.activeChildren.filter(x => x !== c.name); }
           this.shaderManager.saveShadersToProject();
           this.shaderManager.isDirty = true;
           this._updateList();
        };

        const label = this._makeEl('span', { color: 'var(--se-text-primary)' }); label.textContent = c.name;
        left.appendChild(icon); left.appendChild(cb); left.appendChild(label);

        const actions = this._makeEl('div', { display: 'flex', gap: '8px' });
        actions.appendChild(this._createBtn('編集', 'var(--se-accent-2)', () => this._editChildShader(shader.name, c.name)));
        actions.appendChild(this._createBtn('削除', 'var(--se-error)', () => {
          if (!confirm('削除しますか？')) return;
          shader.children = shader.children.filter(x => x.name !== c.name);
          shader.activeChildren = shader.activeChildren.filter(x => x !== c.name);
          this._updateIntegratedList(); this._updateList(); this.shaderManager.saveShadersToProject();
        }));
        
        li.appendChild(left);
        li.appendChild(actions);
        this.integratedChildrenList.appendChild(li);
      });
    }

    _editChildShader(parentName, childName) {
      const parent = this.shaderManager.getShader(parentName);
      if (!parent || !parent.isIntegrated) return;
      const child = parent.children.find(c => c.name === childName);
      if (!child) return;
      this.currentShader = null;
      this.currentChildShaderParent = parentName;
      this.currentChildShaderName = childName;
      this._showCodeEditors();
      this.nameInput.value = childName;
      this.vertexEditor.value = child.vertexSource;
      this.fragmentEditor.value = child.fragmentSource;
      this.jsEditor.value = child.jsSource || '';
      this._setStatus(`子シェーダー編集中: ${childName} (親: ${parentName})`);
      this._updateAIContextBadge();
    }

    _newShader() {
      this.currentShader = null; this.currentChildShaderParent = null; this.currentChildShaderName = null;
      this._isNewShaderPending = true;
      this._showCodeEditors();
      this.nameInput.value = ''; this.nameInput.placeholder = '新規シェーダー名...';
      this.vertexEditor.value = `attribute vec2 a_position;\nattribute vec2 a_texCoord;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_Position = vec4(a_position, 0.0, 1.0);\n  v_texCoord = a_texCoord;\n}`;
      this.fragmentEditor.value = `precision mediump float;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_FragColor = texture2D(u_texture, v_texCoord);\n}`;
      this.jsEditor.value = `// 初期化時に1回呼ばれる\nfunction onInit(api) {\n  \n}\n\n// 毎フレーム呼ばれる\nfunction onFrame(api) {\n  \n}`;
      this._clearEditorErrors(); this.nameInput.focus();
      this._updateModeUI();
    }

    _newIntegratedShader() {
      this.currentShader = null; this.currentChildShaderParent = null; this.currentChildShaderName = null;
      this._isNewShaderPending = true;
      this._showIntegratedEditor();
      this.nameInput.value = ''; this.nameInput.placeholder = '新規統合シェーダー名...';
      this._updateIntegratedList(); this._clearEditorErrors(); this.nameInput.focus();
      this._updateModeUI();
    }

    _createSampleShader(templateName, type) {
      let fCode = `precision mediump float;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_FragColor = texture2D(u_texture, v_texCoord);\n}`;
      if (type === 'wave') {
        fCode = `precision mediump float;\nuniform float u_time;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nconst float SPEED = 5.0;\nconst float FREQUENCY = 10.0;\nconst float STRENGTH = 0.01;\n\nvoid main() {\n  vec2 uv = v_texCoord;\n  uv.x += sin(uv.y * FREQUENCY + u_time * SPEED) * STRENGTH;\n  gl_FragColor = texture2D(u_texture, uv);\n}`;
      } else if (type === 'mosaic') {
        fCode = `precision mediump float;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nconst float BLOCKS = 30.0;\n\nvoid main() {\n  vec2 blocks = vec2(BLOCKS * 1.333, BLOCKS);\n  vec2 uv = floor(v_texCoord * blocks) / blocks;\n  gl_FragColor = texture2D(u_texture, uv);\n}`;
      } else if (type === 'invert') {
        fCode = `precision mediump float;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  vec4 color = texture2D(u_texture, v_texCoord);\n  gl_FragColor = vec4(1.0 - color.rgb, color.a);\n}`;
      } else if (type === 'outline') {
        fCode = `precision mediump float;\nuniform sampler2D u_texture;\nuniform vec2 u_canvasResolution;\nvarying vec2 v_texCoord;\n\nconst float WIDTH = 3.0;\n\nvoid main() {\n  vec4 col = texture2D(u_texture, v_texCoord);\n  if (col.a > 0.5) {\n    gl_FragColor = col;\n  } else {\n    vec2 px = vec2(WIDTH) / u_canvasResolution;\n    float a = 0.0;\n    a += texture2D(u_texture, v_texCoord + vec2(-px.x, 0.0)).a;\n    a += texture2D(u_texture, v_texCoord + vec2(px.x, 0.0)).a;\n    a += texture2D(u_texture, v_texCoord + vec2(0.0, -px.y)).a;\n    a += texture2D(u_texture, v_texCoord + vec2(0.0, px.y)).a;\n    if (a > 0.0) {\n      gl_FragColor = vec4(1.0, 0.9, 0.2, 1.0);\n    } else {\n      gl_FragColor = vec4(0.0);\n    }\n  }\n}`;
      }
      this._createNewShaderDirect(templateName, fCode, null, null);
      this._showToast(`サンプル「${templateName}」を作成しました！`);
    }

    _positionMenu(menu, targetElement) {
      const rect = targetElement.getBoundingClientRect();
      const openUpwards = (rect.bottom + 200 > window.innerHeight);
      if (openUpwards) {
        Object.assign(menu.style, {
          left: Math.max(10, Math.min(rect.left, window.innerWidth - 240)) + 'px',
          bottom: (window.innerHeight - rect.top + 6) + 'px'
        });
      } else {
        Object.assign(menu.style, {
          left: Math.max(10, Math.min(rect.left, window.innerWidth - 240)) + 'px',
          top: (rect.bottom + 6) + 'px'
        });
      }
    }

    _showNewShaderMenu(e) {
      document.querySelectorAll('.se-context-menu').forEach(el => el.remove());
      const menu = this._makeEl('div', { position: 'fixed', background: 'var(--se-bg-secondary)', border: '1px solid var(--se-border)', borderRadius: 'var(--se-radius-sm)', padding: '5px', zIndex: '100015', boxShadow: 'var(--se-shadow)', minWidth: '160px' });
      menu.className = 'se-context-menu';
      const createItem = (text, onClick) => {
        const item = this._makeEl('div', { padding: '8px 12px', cursor: 'pointer', color: 'var(--se-text-primary)', borderRadius: '4px', fontSize: '13px' });
        item.textContent = text;
        item.onmouseenter = () => item.style.background = 'var(--se-bg-hover)';
        item.onmouseleave = () => item.style.background = 'transparent';
        item.onclick = () => { onClick(); menu.remove(); };
        return item;
      };
      menu.appendChild(createItem('📄 単体シェーダー作成', () => this._newShader()));
      menu.appendChild(createItem('📁 統合シェーダー作成', () => this._newIntegratedShader()));
      
      this._positionMenu(menu, e.target);
      document.body.appendChild(menu);
      const close = (ev) => { if(!menu.contains(ev.target) && ev.target!==e.target) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    }

    _showExportMenu(e) {
      document.querySelectorAll('.se-context-menu').forEach(el => el.remove());
      const menu = this._makeEl('div', { position: 'fixed', background: 'var(--se-bg-secondary)', border: '1px solid var(--se-border)', borderRadius: 'var(--se-radius-sm)', padding: '5px', zIndex: '100015', boxShadow: 'var(--se-shadow)', minWidth: '180px' });
      menu.className = 'se-context-menu';
      
      const createItem = (text, onClick) => {
        const item = this._makeEl('div', { padding: '8px 12px', cursor: 'pointer', color: 'var(--se-text-primary)', borderRadius: '4px', fontSize: '13px' });
        item.textContent = text;
        item.onmouseenter = () => item.style.background = 'var(--se-bg-hover)';
        item.onmouseleave = () => item.style.background = 'transparent';
        item.onclick = () => { onClick(); menu.remove(); };
        return item;
      };

      const download = (filename, content) => {
        const blob = new Blob([content], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
      };

      let sName = this.currentShader;
      let s = null;
      if (this.currentChildShaderParent) {
        sName = this.currentChildShaderName;
        const p = this.shaderManager.getShader(this.currentChildShaderParent);
        s = p ? p.children.find(c => c.name === sName) : null;
      } else {
        s = this.shaderManager.getShader(sName);
      }

      if (!s) {
        this._showToast('エクスポートするシェーダーを選択してください', true);
        return;
      }

      if (s.isIntegrated) {
        menu.appendChild(createItem('📦 .zip 形式でエクスポート', async () => {
          try {
            const JSZip = await this._loadJSZip();
            const zip = new JSZip();
            (s.children || []).forEach(c => {
               const code = `#ifdef VERTEX\n${c.vertexSource || ''}\n#endif\n#ifdef FRAGMENT\n${c.fragmentSource || ''}\n#endif\n#ifdef JS\n${c.jsSource || ''}\n#endif`;
               zip.file(`${c.name}.glsl`, code);
            });
            const blob = await zip.generateAsync({ type: 'blob' });
            const a = document.createElement('a');
            const url = URL.createObjectURL(blob);
            a.href = url;
            a.download = `${s.name}.zip`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            this._showToast(`「${s.name}.zip」をエクスポートしました`);
          } catch (err) {
            console.warn('[ShaderEditor] Export error:', err);
            this._showToast(`エクスポート失敗: ${err.message}`, true);
          }
        }));
      } else {
        menu.appendChild(createItem('📄 .glsl 形式 (完全版)', () => {
          const code = `#ifdef VERTEX\n${this.vertexEditor.value}\n#endif\n#ifdef FRAGMENT\n${this.fragmentEditor.value}\n#endif\n#ifdef JS\n${this.jsEditor.value}\n#endif`;
          download(`${sName}.glsl`, code);
        }));
        menu.appendChild(createItem('🎨 .frag のみ (Fragment)', () => download(`${sName}.frag`, this.fragmentEditor.value)));
        menu.appendChild(createItem('📐 .vert のみ (Vertex)', () => download(`${sName}.vert`, this.vertexEditor.value)));
        menu.appendChild(createItem('⚡ .js のみ (JavaScript)', () => download(`${sName}.js`, this.jsEditor.value)));
      }

      this._positionMenu(menu, e.target);
      document.body.appendChild(menu);
      const close = (ev) => { if(!menu.contains(ev.target) && ev.target!==e.target) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    }

    _showImportMenu(e) {
      document.querySelectorAll('.se-context-menu').forEach(el => el.remove());
      const menu = this._makeEl('div', { position: 'fixed', background: 'var(--se-bg-secondary)', border: '1px solid var(--se-border)', borderRadius: 'var(--se-radius-sm)', padding: '5px', zIndex: '100015', boxShadow: 'var(--se-shadow)', minWidth: '200px' });
      menu.className = 'se-context-menu';
      
      const fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.style.display = 'none';
      document.body.appendChild(fileInput);

      const doImport = (ext, callback) => {
        fileInput.accept = ext;
        fileInput.onchange = (ev) => {
          const file = ev.target.files[0];
          if (!file) return;
          const reader = new FileReader();
          const isZip = file.name.toLowerCase().endsWith('.zip') || (file.type && file.type.includes('zip'));
          if (isZip) {
            reader.onload = (e) => callback(e.target.result, file);
            reader.readAsArrayBuffer(file);
          } else {
            reader.onload = (e) => callback(e.target.result, file);
            reader.readAsText(file);
          }
        };
        fileInput.click();
      };

      const createItem = (text, onClick) => {
        const item = this._makeEl('div', { padding: '8px 12px', cursor: 'pointer', color: 'var(--se-text-primary)', borderRadius: '4px', fontSize: '13px' });
        item.textContent = text;
        item.onmouseenter = () => item.style.background = 'var(--se-bg-hover)';
        item.onmouseleave = () => item.style.background = 'transparent';
        item.onclick = () => { onClick(); menu.remove(); fileInput.remove(); };
        return item;
      };

      menu.appendChild(createItem('📥 シェーダーをインポート (.glsl / .zip)', () => {
        doImport('.glsl,.zip,application/zip,application/x-zip-compressed', async (res, file) => {
          try {
            const isZip = file.name.toLowerCase().endsWith('.zip') || (file.type && file.type.includes('zip'));
            if (isZip) {
              const JSZip = await this._loadJSZip();
              if (!JSZip) throw new Error('JSZipライブラリの読み込みに失敗しました。');
              const zip = await JSZip.loadAsync(res);
              const rawName = file.name.replace(/\.zip$/i, '');
              const children = [];

              // ディレクトリや隠しファイルを除外
              const validFilenames = Object.keys(zip.files).filter(fn => {
                if (zip.files[fn].dir) return false;
                if (fn.startsWith('__MACOSX/') || fn.includes('/.')) return false;
                const base = fn.split('/').pop();
                return base && !base.startsWith('.');
              });

              // ファイル名順でソート（自然順序）
              validFilenames.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

              for (const filename of validFilenames) {
                const baseName = filename.split('/').pop();
                if (baseName.toLowerCase().endsWith('.glsl')) {
                  const content = await zip.files[filename].async('string');
                  const parsed = this._parseGLSLFile(content);
                  children.push({
                    name: baseName.replace(/\.glsl$/i, ''),
                    frag: parsed.fragmentSource,
                    vert: parsed.vertexSource,
                    js: parsed.jsSource
                  });
                } else if (baseName.toLowerCase().endsWith('.frag')) {
                  const content = await zip.files[filename].async('string');
                  children.push({
                    name: baseName.replace(/\.frag$/i, ''),
                    frag: content,
                    vert: null,
                    js: null
                  });
                }
              }

              if (children.length === 0) {
                throw new Error('ZIP内に有効なシェーダーファイル (.glsl) が見つかりませんでした。');
              }

              const createdName = this._createNewIntegratedShaderDirect(rawName, children);
              if (createdName) {
                this._showToast(`✨ 統合シェーダー「${createdName}」(子: ${children.length}件) をインポートしました！`);
              } else {
                throw new Error('統合シェーダーの登録に失敗しました。');
              }
            } else {
              // 単体GLSLファイルのインポート
              const parsed = this._parseGLSLFile(res);
              const rawName = file.name.replace(/\.glsl$/i, '');
              const createdName = this._createNewShaderDirect(rawName, parsed.fragmentSource, parsed.vertexSource, parsed.jsSource);
              if (createdName) {
                this._updateList();
                this._updateAIContextBadge();
                this._showToast(`✨ シェーダー「${createdName}」をインポートしました！`);
              } else {
                throw new Error('シェーダーの登録に失敗しました。');
              }
            }
          } catch (err) {
            console.warn('[ShaderEditor] Import error:', err);
            this._showToast(`⚠️ インポート失敗: ${err.message}`, true);
          }
        });
      }));

      let s = null;
      if (this.currentChildShaderParent) {
         const p = this.shaderManager.getShader(this.currentChildShaderParent);
         s = p ? p.children.find(c => c.name === this.currentChildShaderName) : null;
      } else {
         s = this.shaderManager.getShader(this.currentShader);
      }

      if (s && !s.isIntegrated) {
          menu.appendChild(createItem('🔄 現在のシェーダーを上書き (.glsl)', () => {
              doImport('.glsl', (res) => {
                  const parsed = this._parseGLSLFile(res);
                  this.vertexEditor.value = parsed.vertexSource;
                  this.fragmentEditor.value = parsed.fragmentSource;
                  this.jsEditor.value = parsed.jsSource;
                  this._autoSaveShader(); this._showToast('上書きしました');
              });
          }));
          menu.appendChild(createItem('🎨 Fragment のみ上書き (.frag)', () => { doImport('.frag', res => { this.fragmentEditor.value = res; this._autoSaveShader(); }); }));
          menu.appendChild(createItem('📐 Vertex のみ上書き (.vert)', () => { doImport('.vert', res => { this.vertexEditor.value = res; this._autoSaveShader(); }); }));
          menu.appendChild(createItem('⚡ JS のみ上書き (.js)', () => { doImport('.js', res => { this.jsEditor.value = res; this._autoSaveShader(); }); }));
      }

      this._positionMenu(menu, e.target);
      document.body.appendChild(menu);
      const close = (ev) => { if(!menu.contains(ev.target) && ev.target!==e.target) { menu.remove(); document.removeEventListener('click', close); fileInput.remove(); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    }

    _parseGLSLFile(content) {
        let vertexSource = '', fragmentSource = '', jsSource = '';
        const lines = content.split('\n');
        let mode = 'fragment';
        let vLines = [], fLines = [], jLines = [];
        for (let line of lines) {
            const t = line.trim();
            if (t === '#ifdef VERTEX') { mode = 'vertex'; continue; }
            if (t === '#ifdef FRAGMENT') { mode = 'fragment'; continue; }
            if (t === '#ifdef JS') { mode = 'js'; continue; }
            if (t === '#endif') { mode = 'fragment'; continue; }
            if (mode === 'vertex') vLines.push(line);
            else if (mode === 'fragment') fLines.push(line);
            else if (mode === 'js') jLines.push(line);
        }
        if (vLines.length) vertexSource = vLines.join('\n');
        else vertexSource = `attribute vec2 a_position;\nattribute vec2 a_texCoord;\nvarying vec2 v_texCoord;\nvoid main() {\n  gl_Position = vec4(a_position, 0.0, 1.0);\n  v_texCoord = a_texCoord;\n}`;
        
        fragmentSource = fLines.length ? fLines.join('\n') : content;
        jsSource = jLines.join('\n');
        return { vertexSource, fragmentSource, jsSource };
    }

    async _loadJSZip() {
      if (window.JSZip) return window.JSZip;
      const cdns = [
        'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
        'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
        'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'
      ];

      for (const url of cdns) {
        try {
          const zipInstance = await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = () => resolve(window.JSZip);
            script.onerror = () => { script.remove(); reject(); };
            document.head.appendChild(script);
          });
          if (zipInstance) return zipInstance;
        } catch (e) {
          // 次のCDNへフォールバック
        }
      }
      throw new Error('JSZipの読み込みに失敗しました。ネットワーク接続をご確認ください。');
    }

    // Google Fonts (Inter + JetBrains Mono) 読み込み
    _loadFonts() {
      if (document.getElementById('se-fonts')) return;
      const link = document.createElement('link');
      link.id = 'se-fonts';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap';
      document.head.appendChild(link);
    }

    // Material Symbols アイコンフォント読み込み
    _loadMaterialIcons() {
      if (document.querySelector('link[href*="Material+Symbols"]')) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200';
      document.head.appendChild(link);
    }

    // Prism.js + CSSデザインシステム読み込み
    async _loadPrism() {
      if (window.Prism) return;

      // CSSデザインシステム注入
      const style = document.createElement('style');
      style.id = 'se-design-system';
      style.textContent = `
        :root {
          --se-bg-primary: #0a0b12;
          --se-bg-secondary: #12141f;
          --se-bg-tertiary: #191c2b;
          --se-bg-editor: #0e101a;
          --se-bg-hover: rgba(255,255,255,0.06);
          --se-border: rgba(255,255,255,0.08);
          --se-border-active: rgba(124,108,240,0.6);
          --se-text-primary: #f0f2fa;
          --se-text-secondary: #8c93a8;
          --se-text-muted: #575c70;
          --se-accent: #7c6cf0;
          --se-accent-2: #00cec9;
          --se-accent-gradient: linear-gradient(135deg, #7c6cf0 0%, #00cec9 100%);
          --se-success: #00b894;
          --se-error: #ff7675;
          --se-warning: #fdcb6e;
          --se-radius: 12px;
          --se-radius-sm: 6px;
          --se-transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          --se-font-ui: 'Inter', -apple-system, system-ui, sans-serif;
          --se-font-code: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
          --se-shadow: 0 25px 60px -10px rgba(0,0,0,0.7), 0 0 1px 1px rgba(255,255,255,0.05);
        }
        .se-btn {
          font-family: var(--se-font-ui); font-size: 13px; font-weight: 600;
          padding: 7px 14px; border: none; border-radius: var(--se-radius-sm);
          color: #fff; cursor: pointer; display: inline-flex; align-items: center;
          gap: 6px; transition: var(--se-transition); user-select: none;
          box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        }
        .se-btn:hover { filter: brightness(1.15); transform: translateY(-1px); }
        .se-btn:active { transform: translateY(0); filter: brightness(0.95); }
        .se-input, .se-select {
          font-family: var(--se-font-ui); font-size: 13px; padding: 7px 12px;
          background: var(--se-bg-tertiary); color: var(--se-text-primary);
          border: 1px solid var(--se-border); border-radius: var(--se-radius-sm);
          outline: none; transition: var(--se-transition);
        }
        .se-input:focus, .se-select:focus { border-color: var(--se-accent); box-shadow: 0 0 0 2px rgba(124,108,240,0.25); }
        .se-tab-btn {
          font-family: var(--se-font-ui); font-size: 12px; font-weight: 600;
          padding: 6px 14px; background: transparent; color: var(--se-text-secondary);
          border: none; border-radius: 4px; cursor: pointer;
          display: inline-flex; align-items: center; gap: 5px; transition: var(--se-transition);
          user-select: none;
        }
        .se-tab-btn:hover { color: var(--se-text-primary); background: var(--se-bg-hover); }
        .se-tab-btn.active { color: #fff; background: var(--se-accent); box-shadow: 0 2px 10px rgba(124,108,240,0.4); }
        .se-list-item {
          padding: 9px 12px; margin-bottom: 4px; border-radius: var(--se-radius-sm);
          cursor: pointer; display: flex; align-items: center; gap: 10px;
          color: var(--se-text-secondary); font-size: 13px; font-weight: 500;
          transition: var(--se-transition); border: 1px solid transparent; user-select: none;
        }
        .se-list-item:hover { background: var(--se-bg-hover); color: var(--se-text-primary); }
        .se-list-item.active { background: rgba(124,108,240,0.14); border-color: rgba(124,108,240,0.4); color: #fff; font-weight: 600; }
        .shader-editor-code, .shader-editor-code span, .shader-editor-code .token {
          font-family: var(--se-font-code) !important; font-size: 14px !important;
          line-height: 1.7 !important; tab-size: 2 !important; -moz-tab-size: 2 !important;
          font-style: normal !important; font-weight: 400 !important;
        }
        .se-window ::-webkit-scrollbar { width: 7px; height: 7px; }
        .se-window ::-webkit-scrollbar-track { background: transparent; }
        .se-window ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
        .se-window ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
        .se-toggle { position: relative; display: inline-block; width: 32px; height: 16px; flex-shrink: 0; }
        .se-toggle input { opacity: 0; width: 0; height: 0; }
        .se-toggle-slider {
          position: absolute; cursor: pointer; inset: 0;
          background: rgba(255,255,255,0.12); border-radius: 16px;
          transition: var(--se-transition);
        }
        .se-toggle-slider:before {
          content: ""; position: absolute; height: 10px; width: 10px;
          left: 3px; bottom: 3px; background: #fff; border-radius: 50%;
          transition: var(--se-transition);
        }
        .se-toggle input:checked + .se-toggle-slider { background: var(--se-success); }
        .se-toggle input:checked + .se-toggle-slider:before { transform: translateX(16px); }
        
        /* ChatGPT / Cursor 風 チャットUIスタイル */
        .se-chat-msg { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; animation: se-fade-in 0.2s ease-out; }
        .se-chat-user-bubble {
          align-self: flex-end; max-width: 85%; background: #262938; color: #f0f2fa;
          padding: 10px 16px; border-radius: 18px 18px 4px 18px; font-size: 13.5px;
          line-height: 1.6; border: 1px solid rgba(255,255,255,0.08); word-break: break-word;
          box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        }
        .se-chat-model-bubble {
          align-self: flex-start; width: 100%; color: #e2e4ed; font-size: 13.5px;
          line-height: 1.65; word-break: break-word;
        }
        .se-code-card {
          background: #090a10; border: 1px solid rgba(255,255,255,0.12);
          border-radius: 10px; margin: 10px 0; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        }
        .se-code-card-header {
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px 14px; background: #131520; border-bottom: 1px solid rgba(255,255,255,0.08);
          font-size: 11.5px; font-weight: 700; color: #8c93a8; text-transform: uppercase; letter-spacing: 0.5px;
        }
        .se-code-card-body {
          padding: 12px 14px; font-family: var(--se-font-code); font-size: 13px;
          line-height: 1.5; overflow-x: auto; color: #f0f2fa; white-space: pre; margin: 0;
          background: #090a10;
        }
        .se-code-card-footer {
          display: flex; gap: 8px; padding: 8px 14px; background: #131520;
          border-top: 1px solid rgba(255,255,255,0.08); justify-content: flex-end;
        }
        .se-pill-chip {
          display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px;
          background: var(--se-bg-tertiary); border: 1px solid var(--se-border);
          border-radius: 20px; font-size: 12.5px; color: var(--se-text-secondary);
          cursor: pointer; transition: var(--se-transition); user-select: none;
        }
        .se-pill-chip:hover {
          border-color: var(--se-accent); color: var(--se-text-primary);
          background: rgba(124,108,240,0.12); transform: translateY(-1px);
        }
        .se-chat-input-bar {
          display: flex; align-items: flex-end; gap: 8px; background: #181b28;
          border: 1px solid rgba(255,255,255,0.15); border-radius: 22px;
          padding: 8px 12px; transition: var(--se-transition); box-shadow: 0 4px 20px rgba(0,0,0,0.25);
        }
        .se-chat-input-bar:focus-within {
          border-color: var(--se-accent); box-shadow: 0 0 0 3px rgba(124,108,240,0.25), 0 4px 20px rgba(0,0,0,0.3);
        }
        .se-chat-textarea {
          flex: 1; background: transparent; border: none; outline: none;
          color: var(--se-text-primary); font-family: var(--se-font-ui);
          font-size: 13.5px; line-height: 1.4; resize: none; max-height: 140px; min-height: 24px; padding: 4px 6px;
          overflow: hidden !important; scrollbar-width: none !important; -ms-overflow-style: none !important;
        }
        .se-chat-textarea::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
        .se-send-btn {
          width: 32px; height: 32px; border-radius: 50%; border: none;
          background: var(--se-accent); color: #fff; display: flex; align-items: center;
          justify-content: center; cursor: pointer; transition: var(--se-transition); flex-shrink: 0;
          box-shadow: 0 2px 8px rgba(124,108,240,0.4);
        }
        .se-send-btn:hover { filter: brightness(1.15); transform: scale(1.05); }
        .se-send-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }
        
        .se-mode-badge {
          display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
          border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
          background: var(--se-bg-tertiary); color: var(--se-text-secondary);
          border: 1px solid var(--se-border); transition: var(--se-transition); user-select: none;
        }
        .se-mode-badge:hover { color: var(--se-text-primary); border-color: var(--se-accent); }
        .se-mode-badge.active { background: rgba(124,108,240,0.2); color: #fff; border-color: var(--se-accent); }

        @keyframes se-fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes se-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      `;
      document.head.appendChild(style);

      // Prism.js テーマ CSS
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css';
      document.head.appendChild(link);

      // Prism.js 本体 + 言語コンポーネント
      const scripts = [
        'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-c.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-glsl.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js'
      ];
      for (const src of scripts) {
        await new Promise((resolve) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = resolve;
          document.head.appendChild(s);
        });
      }
    }

    _autoSaveShader() {
      if (!this.currentShader && !this.currentChildShaderParent) return;
      this._clearEditorErrors();
      const isEditingChild = this.currentChildShaderParent !== null;
      
      let vErr = null, fErr = null;
      if (!isEditingChild || (isEditingChild && this.shaderManager.getShader(this.currentChildShaderParent))) {
         try { this.shaderManager.compileShader(this.vertexEditor.value, this.shaderManager.gl.VERTEX_SHADER); } catch(e) { vErr = e.message; }
         try { this.shaderManager.compileShader(this.fragmentEditor.value, this.shaderManager.gl.FRAGMENT_SHADER); } catch(e) { fErr = e.message; }
      }

      if (vErr || fErr) {
         this._showCompileError(vErr ? 'Vertex:\n' + vErr : null, fErr ? 'Fragment:\n' + fErr : null);
      }

      if (isEditingChild) {
        const parent = this.shaderManager.getShader(this.currentChildShaderParent);
        if (!parent) return;
        const child = parent.children.find(c => c.name === this.currentChildShaderName);
        if (!child) return;
        child.vertexSource = this.vertexEditor.value;
        child.fragmentSource = this.fragmentEditor.value;
        child.jsSource = this.jsEditor.value;
        try {
          const p = this.shaderManager.createProgram(child.vertexSource, child.fragmentSource);
          child.program = p.program;
          child.uniforms = p.uniforms;
          child.uniformValues = Object.assign({}, p.constDefaults || {}, child.uniformValues || {});
        } catch(e) {
          child.program = null;
          child.uniforms = {}; 
        }
        if (!child.jsState) child.jsState = { initialized: false, module: null };
        child.jsState.module = this.shaderManager._compileJs(child.jsSource);
        child.jsState.initialized = false;
        this.shaderManager.saveShadersToProject();
        this.shaderManager.isDirty = true;
        if (!vErr && !fErr) this._showCompileError(null, null);
        return;
      }
      
      const name = this.currentShader;
      if (this.integratedArea.style.display === 'flex') { this.shaderManager.saveShadersToProject(); return; }
      const res = this.shaderManager.addShader(name, this.vertexEditor.value, this.fragmentEditor.value, this.jsEditor.value);
      if (res && res.success) {
        this.shaderManager.saveShadersToProject();
        if (!vErr && !fErr) this._showCompileError(null, null);
      }
    }

    _onNameInputConfirm() {
      const name = this.nameInput.value.trim();
      if (!name) return;
      if (this._isNewShaderPending) {
        if (this.shaderManager.shaders.has(name)) return alert('同名が存在します');
        const isInt = this.integratedArea.style.display === 'flex';
        let res = isInt ? this.shaderManager.addIntegratedShader(name, []) : this.shaderManager.addShader(name, this.vertexEditor.value, this.fragmentEditor.value, this.jsEditor.value);
        if (res && res.success) {
          this.currentShader = name;
          this._isNewShaderPending = false;
          this.shaderManager.setEnabled(name, true);
          this.shaderManager.saveShadersToProject();
          this.loadShader(name);
          this._showToast('作成しました');
        }
        return;
      }
      if (this.currentChildShaderParent) {
         if (this.currentChildShaderName !== name) {
            this._renameChildShader(this.currentChildShaderParent, this.currentChildShaderName, name);
            this.currentChildShaderName = name;
         }
         return;
      }
      if (this.currentShader && this.currentShader !== name) {
        if (this.shaderManager.shaders.has(name)) return alert('同名が存在します');
        this._renameShader(this.currentShader, name);
        this.currentShader = name; this.nameInput.value = name;
      }
    }

    _renameShader(oldName, newName) {
       const newMap = new Map();
       for (const [k,v] of this.shaderManager.shaders) {
          if (k === oldName) {
             v.name = newName;
             newMap.set(newName, v);
          } else {
             newMap.set(k, v);
          }
       }
       this.shaderManager.shaders = newMap;
       const idx = this.shaderManager.activeShaders.indexOf(oldName);
       if (idx > -1) this.shaderManager.activeShaders[idx] = newName;
       this._updateList(); this.shaderManager.saveShadersToProject();
    }

    _renameChildShader(parentName, oldName, newName) {
       const parent = this.shaderManager.getShader(parentName);
       if (!parent) return;
       const child = parent.children.find(c => c.name === oldName);
       if(child) {
          child.name = newName;
          const idx = parent.activeChildren.indexOf(oldName);
          if (idx > -1) parent.activeChildren[idx] = newName;
       }
       this._updateList(); this.shaderManager.saveShadersToProject();
    }

    _moveShaderToIntegrated(name) {
       const intShaders = Array.from(this.shaderManager.shaders.keys()).filter(k => this.shaderManager.getShader(k).isIntegrated);
       if(intShaders.length === 0) return alert('統合シェーダーが存在しません');
       const target = prompt('移動先の統合シェーダー名:\n' + intShaders.join('\n'));
       if(!target) return;
       const tShader = this.shaderManager.getShader(target);
       if(!tShader || !tShader.isIntegrated) return alert('無効な対象です');
       const s = this.shaderManager.getShader(name);
       if(!s) return;
       tShader.children.push({ name: name, vertexSource: s.vertexSource, fragmentSource: s.fragmentSource, jsSource: s.jsSource||'', ...this.shaderManager.createProgram(s.vertexSource, s.fragmentSource), uniformValues: s.uniformValues||{}, isIntegrated: false, children: [], activeChildren: [] });
       tShader.activeChildren.push(name);
       this.shaderManager.removeShader(name);
       this.shaderManager.saveShadersToProject();
       this._updateList();
       if(this.currentShader === target) this._updateIntegratedList();
       if(this.currentShader === name) this._showEmptyState();
       this._showToast('移動しました');
    }

    _copyShaderToIntegrated(name) {
       const intShaders = Array.from(this.shaderManager.shaders.keys()).filter(k => this.shaderManager.getShader(k).isIntegrated);
       if(intShaders.length === 0) return alert('統合シェーダーが存在しません');
       const target = prompt('コピー先の統合シェーダー名:\n' + intShaders.join('\n'));
       if(!target) return;
       const tShader = this.shaderManager.getShader(target);
       if(!tShader || !tShader.isIntegrated) return alert('無効な対象です');
       const s = this.shaderManager.getShader(name);
       if(!s) return;
       tShader.children.push({ name: name, vertexSource: s.vertexSource, fragmentSource: s.fragmentSource, jsSource: s.jsSource||'', ...this.shaderManager.createProgram(s.vertexSource, s.fragmentSource), uniformValues: JSON.parse(JSON.stringify(s.uniformValues||{})), isIntegrated: false, children: [], activeChildren: [] });
       tShader.activeChildren.push(name);
       this.shaderManager.saveShadersToProject();
       this._updateList();
       if(this.currentShader === target) this._updateIntegratedList();
       this._showToast('コピーしました');
    }

    _decomposeIntegratedShader(name) {
       if(!confirm('独立したシェーダーに分解しますか？')) return;
       const shader = this.shaderManager.getShader(name);
       if(!shader || !shader.isIntegrated) return;
       shader.children.forEach(c => {
          let newName = c.name;
          let i = 2; while(this.shaderManager.shaders.has(newName)) newName = `${c.name} ${i++}`;
          this.shaderManager.addShader(newName, c.vertexSource, c.fragmentSource, c.jsSource);
       });
       this.shaderManager.removeShader(name);
       this.shaderManager.saveShadersToProject();
       this._updateList();
       if(this.currentShader === name) this._showEmptyState();
       this._showToast('分解しました');
    }

    _deleteShader() {
      if (!this.currentShader && !this.currentChildShaderParent) return;
      if (!confirm('削除しますか？')) return;
      
      if (this.currentChildShaderParent) {
         const p = this.shaderManager.getShader(this.currentChildShaderParent);
         if(p) {
            p.children = p.children.filter(c => c.name !== this.currentChildShaderName);
            p.activeChildren = p.activeChildren.filter(x => x !== this.currentChildShaderName);
            this.shaderManager.saveShadersToProject();
         }
         this.loadShader(this.currentChildShaderParent);
         this._showToast('削除しました', true);
         return;
      }
      
      this.shaderManager.removeShader(this.currentShader);
      this.shaderManager.saveShadersToProject();
      this._showEmptyState('削除しました');
      this._showToast('削除しました', true);
    }

    _saveShader() { this._autoSaveShader(); this._showToast('保存しました'); }

    loadShader(name) {
      if (!name) { this._showEmptyState('選択してください'); return; }
      const shader = this.shaderManager.getShader(name);
      if (!shader) { this._showEmptyState('見つかりません'); return; }
      this.currentShader = name; this._isNewShaderPending = false;
      this.currentChildShaderParent = null; this.currentChildShaderName = null;
      this.nameInput.value = name; this._clearEditorErrors();
      if (shader.isIntegrated) {
        this._showIntegratedEditor(); this._updateIntegratedList();
      } else {
        this._showCodeEditors();
        this.vertexEditor.value = shader.vertexSource;
        this.fragmentEditor.value = shader.fragmentSource;
        this.jsEditor.value = shader.jsSource || '';
      }
      this._updateList(); this._updateModeUI();
      this._updateAIContextBadge();
    }

    _updateModeUI() {
      if (this._isNewShaderPending) {
        this.modeBadge.style.display = 'inline-block';
        this.modeBadge.textContent = 'NEW';
        this.modeBadge.style.background = 'var(--se-accent)';
        this.btnCreate.style.display = 'inline-flex'; this.btnCancel.style.display = 'inline-flex';
        this.btnDel.style.display = 'none';
      } else if (this.currentShader || this.currentChildShaderParent) {
        this.modeBadge.style.display = 'inline-block';
        this.modeBadge.textContent = this.integratedArea.style.display === 'flex' ? 'INTEGRATED' : 'SINGLE';
        this.modeBadge.style.background = 'rgba(255,255,255,0.08)';
        this.btnCreate.style.display = 'none'; this.btnCancel.style.display = 'none';
        this.btnDel.style.display = 'inline-flex';
      } else {
        this.modeBadge.style.display = 'none';
        this.btnCreate.style.display = 'none'; this.btnCancel.style.display = 'none';
        this.btnDel.style.display = 'none';
      }
    }

    _cancelNewShaderCreation() { this._isNewShaderPending = false; this._showEmptyState('キャンセルしました'); }

    _showCompileError(vErr, fErr) {
      this._clearEditorErrors();
      if(vErr && this.vertexPanel) { this.vertexPanel.errorPanel.textContent = vErr; this.vertexPanel.errorPanel.style.maxHeight = '80px'; this.vertexPanel.errorPanel.style.padding = '10px'; }
      if(fErr && this.fragmentPanel) { this.fragmentPanel.errorPanel.textContent = fErr; this.fragmentPanel.errorPanel.style.maxHeight = '80px'; this.fragmentPanel.errorPanel.style.padding = '10px'; }
      if(vErr || fErr) {
        this._lastCompilationError = (vErr ? 'Vertex Shader Error:\n' + vErr + '\n' : '') + (fErr ? 'Fragment Shader Error:\n' + fErr : '');
        if (this.aiFixErrorBox) this.aiFixErrorBox.textContent = this._lastCompilationError;
        this._setStatus('✖ コンパイルエラー');
      } else {
        this._lastCompilationError = null;
        if (this.aiFixErrorBox) this.aiFixErrorBox.textContent = 'エラーは検出されていません。正常に動作しています。';
        this._setStatus('保存しました');
      }
    }
    _clearEditorErrors() {
      [this.vertexPanel, this.fragmentPanel, this.jsPanel].forEach(p => { if(p) { p.errorPanel.textContent=''; p.errorPanel.style.maxHeight='0'; p.errorPanel.style.padding='0'; } });
    }

    _setupDragAndDrop() {
      let draggedItem = null;
      this.shaderList.addEventListener('dragstart', (e) => {
        const li = e.target.closest('.se-list-item');
        if (!li) return;
        draggedItem = li;
        e.dataTransfer.effectAllowed = 'move';
        li.style.opacity = '0.5';
      });
      this.shaderList.addEventListener('dragend', (e) => {
        if (draggedItem) draggedItem.style.opacity = '1';
        draggedItem = null;
      });
      this.shaderList.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const li = e.target.closest('.se-list-item');
        if (li && li !== draggedItem && !li.dataset.parentName && draggedItem && !draggedItem.dataset.parentName) {
           const rect = li.getBoundingClientRect();
           const next = (e.clientY - rect.top)/(rect.bottom - rect.top) > 0.5;
           this.shaderList.insertBefore(draggedItem, next ? li.nextSibling : li);
        }
      });
      this.shaderList.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!draggedItem || draggedItem.dataset.parentName) return;
        draggedItem.style.opacity = '1';
        const newOrder = Array.from(this.shaderList.querySelectorAll('.se-list-item:not([data-parent-name])'))
            .map(li => ({
                name: li.dataset.shaderName,
                on: li.querySelector('input[type="checkbox"]').checked
            }))
            .filter(x => x.on)
            .map(x => x.name);
        this.shaderManager.activeShaders = newOrder;
        this.shaderManager.saveShadersToProject();
        this.shaderManager.isDirty = true;
      });
    }

    _showContextMenu(e, name, parentName = null) {
      e.preventDefault();
      document.querySelectorAll('.se-context-menu').forEach(el => el.remove());
      const menu = this._makeEl('div', {
        position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px',
        background: 'var(--se-bg-secondary)', border: '1px solid var(--se-border)',
        borderRadius: 'var(--se-radius-sm)', padding: '5px', zIndex: '100015',
        boxShadow: 'var(--se-shadow)', minWidth: '150px'
      });
      menu.className = 'se-context-menu';

      const addItem = (text, icon, onClick) => {
        const item = this._makeEl('div', {
          padding: '8px 12px', cursor: 'pointer', color: 'var(--se-text-primary)',
          borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px'
        });
        const iEl = this._makeEl('span', { className: 'material-symbols-outlined', fontSize: '16px' });
        iEl.textContent = icon;
        item.appendChild(iEl); item.appendChild(document.createTextNode(text));
        item.onmouseenter = () => item.style.background = 'var(--se-bg-hover)';
        item.onmouseleave = () => item.style.background = 'transparent';
        item.onclick = () => { onClick(); menu.remove(); };
        menu.appendChild(item);
      };

      if (parentName) {
         addItem('名前変更', 'edit', () => {
            const newName = prompt('新しい名前:', name);
            if(newName) this._renameChildShader(parentName, name, newName);
         });
         addItem('独立させる', 'output', () => {
            const p = this.shaderManager.getShader(parentName);
            const cIdx = p.children.findIndex(c => c.name === name);
            if(cIdx > -1) {
              const c = p.children.splice(cIdx, 1)[0];
              p.activeChildren = p.activeChildren.filter(x => x !== name);
              this.shaderManager.addShader(c.name, c.vertexSource, c.fragmentSource, c.jsSource);
              this.shaderManager.saveShadersToProject();
              this._updateList();
            }
         });
         addItem('削除', 'delete', () => {
            if(confirm('削除しますか？')) {
               const p = this.shaderManager.getShader(parentName);
               p.children = p.children.filter(c => c.name !== name);
               p.activeChildren = p.activeChildren.filter(x => x !== name);
               this.shaderManager.saveShadersToProject();
               this._updateList();
               if(this.currentShader === parentName) this._updateIntegratedList();
            }
         });
      } else {
         addItem('名前変更', 'edit', () => {
            const newName = prompt('新しい名前:', name);
            if(newName) this._renameShader(name, newName);
         });
         const shader = this.shaderManager.getShader(name);
         if (shader.isIntegrated) {
            addItem('分解する', 'call_split', () => this._decomposeIntegratedShader(name));
         } else {
            addItem('統合へ移動', 'move_down', () => this._moveShaderToIntegrated(name));
            addItem('統合へコピー', 'content_copy', () => this._copyShaderToIntegrated(name));
         }
         addItem('削除', 'delete', () => {
            if(confirm('削除しますか？')) {
               this.shaderManager.removeShader(name);
               this.shaderManager.saveShadersToProject();
               if (this.currentShader === name) this._showEmptyState();
               this._updateList();
            }
         });
      }

      document.body.appendChild(menu);
      const close = (ev) => { if(!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    }

    _updateList() {
      this.shaderList.replaceChildren();
      Array.from(this.shaderManager.shaders.keys()).forEach(name => {
        const shader = this.shaderManager.getShader(name);
        const li = this._makeEl('li', { position: 'relative' });
        li.className = 'se-list-item' + (name === this.currentShader ? ' active' : '');
        li.dataset.shaderName = name;
        li.draggable = true;

        if (shader.isIntegrated) {
            const toggle = this._makeEl('span', { fontSize: '12px', cursor: 'pointer', userSelect: 'none', width: '16px', display: 'inline-block', textAlign: 'center' });
            const isCollapsed = this.collapsedIntegrated.has(name);
            toggle.textContent = isCollapsed ? '▶' : '▼';
            toggle.onclick = (e) => {
               e.stopPropagation();
               if (isCollapsed) this.collapsedIntegrated.delete(name);
               else this.collapsedIntegrated.add(name);
               this._updateList();
            };
            li.appendChild(toggle);
        } else {
            li.appendChild(this._makeEl('span', { width: '16px', display: 'inline-block' }));
        }
        
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = this.shaderManager.activeShaders.includes(name);
        cb.onchange = (e) => { this.shaderManager.setEnabled(name, e.target.checked); this.shaderManager.saveShadersToProject(); };
        li.appendChild(cb);

        const icon = this._makeEl('span', { fontSize: '14px', color: shader.isIntegrated ? 'var(--se-warning)' : 'var(--se-accent-2)' });
        icon.textContent = shader.isIntegrated ? '📁' : '📄';
        li.appendChild(icon);

        const text = this._makeEl('span', { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }); text.textContent = name;
        li.appendChild(text);

        li.onclick = (e) => { if(e.target!==cb && e.target.textContent !== '▼' && e.target.textContent !== '▶') { this.loadShader(name); } };
        li.oncontextmenu = (e) => this._showContextMenu(e, name);
        this.shaderList.appendChild(li);

        if (shader.isIntegrated && !this.collapsedIntegrated.has(name)) {
            shader.children.forEach(child => {
                const cli = this._makeEl('li', { paddingLeft: '28px' });
                cli.className = 'se-list-item' + ((name === this.currentChildShaderParent && child.name === this.currentChildShaderName) ? ' active' : '');
                cli.dataset.parentName = name;
                cli.dataset.childName = child.name;

                const ccb = document.createElement('input'); ccb.type = 'checkbox';
                ccb.checked = shader.activeChildren.includes(child.name);
                ccb.onchange = (e) => {
                    if (e.target.checked) { if (!shader.activeChildren.includes(child.name)) shader.activeChildren.push(child.name); }
                    else { shader.activeChildren = shader.activeChildren.filter(x => x !== child.name); }
                    this.shaderManager.saveShadersToProject(); this.shaderManager.isDirty = true;
                };
                cli.appendChild(ccb);

                const cicon = this._makeEl('span', { fontSize: '12px', color: 'var(--se-text-muted)' });
                cicon.textContent = '└';
                cli.appendChild(cicon);

                const ctext = this._makeEl('span', { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' }); ctext.textContent = child.name;
                cli.appendChild(ctext);

                cli.onclick = (e) => { if(e.target!==ccb) this._editChildShader(name, child.name); };
                cli.oncontextmenu = (e) => this._showContextMenu(e, child.name, name);
                this.shaderList.appendChild(cli);
            });
        }
      });
    }

    _updateUIModeButton() {
      if (!this.btnToggleUIMode) return;
      if (this.uiMode === 'chat') {
        this.btnToggleUIMode.textContent = '💬 対話メイン (Cursor風)';
        this.btnToggleUIMode.classList.add('active');
      } else {
        this.btnToggleUIMode.textContent = '◫ 標準IDEモード';
        this.btnToggleUIMode.classList.remove('active');
      }
    }

    _updateModelBadge() {
      if (!this.btnModelBadge) return;
      const m = this.gemini.getModel() || 'gemini-2.5-flash';
      this.btnModelBadge.textContent = `✨ ${m} ⌵`;
    }

    _toggleUIMode() {
      this._setUIMode(this.uiMode === 'ide' ? 'chat' : 'ide');
    }

    _updateAIContextBadge() {
      if (!this.aiContextBar || !this.aiContextText) return;
      if (this.isContextIgnored) {
        this.aiContextBar.style.background = 'rgba(255,255,255,0.03)';
        this.aiContextBar.style.borderColor = 'var(--se-border)';
        this.aiContextText.textContent = 'なし (参照解除中)';
        this.aiContextText.style.color = 'var(--se-text-muted)';
        this.btnToggleContext.textContent = '＋ 参照する';
        this.btnToggleContext.style.color = 'var(--se-accent)';
        this.btnToggleContext.style.display = 'inline-block';
        return;
      }

      this.aiContextBar.style.background = 'rgba(124,108,240,0.08)';
      this.aiContextBar.style.borderColor = 'rgba(124,108,240,0.2)';
      this.aiContextText.style.color = 'var(--se-accent-2)';
      this.btnToggleContext.textContent = '✕ 解除';
      this.btnToggleContext.style.color = 'var(--se-text-muted)';

      const current = this._getCurrentShaderData();
      if (!current || (!current.name && !current.fragmentSource && !current.vertexSource)) {
        this.aiContextText.textContent = 'なし (新規シェーダー作成プロンプト)';
        this.aiContextText.style.color = 'var(--se-text-muted)';
        this.btnToggleContext.style.display = 'none';
      } else {
        this.btnToggleContext.style.display = 'inline-block';
        if (current.isIntegrated) {
          const childTxt = this.currentChildShaderName ? ` › ${this.currentChildShaderName}` : '';
          this.aiContextText.textContent = `📁 統合: ${current.name || '統合シェーダー'}${childTxt}`;
        } else {
          const parts = [];
          if (current.fragmentSource) parts.push('Frag');
          if (current.vertexSource) parts.push('Vert');
          if (current.jsSource) parts.push('JS');
          const types = parts.length > 0 ? ` (${parts.join('+')})` : '';
          this.aiContextText.textContent = `📄 ${current.name || 'シェーダー'}${types}`;
        }
      }
    }

    _setUIMode(mode) {
      this.uiMode = mode;
      localStorage.setItem('se_ui_mode', mode);
      this._updateUIModeButton();

      if (mode === 'chat') {
        this.isAIPanelOpen = true;
        this.aiPanel.style.display = 'flex';
        this.aiPanel.style.flex = '1';
        this.aiPanel.style.width = 'auto';
        this.aiPanel.style.minWidth = '0';
        this.aiPanel.style.order = '1';
        this.aiPanel.style.borderLeft = 'none';

        if (this.centerArea) {
          if (this.isSideEditorOpenInChatMode) {
            this.centerArea.style.display = 'flex';
            this.centerArea.style.flex = 'none';
            this.centerArea.style.width = '520px';
            this.centerArea.style.maxWidth = '55%';
            this.centerArea.style.minWidth = '360px';
            this.centerArea.style.order = '2';
            this.centerArea.style.borderLeft = '1px solid var(--se-border)';
          } else {
            this.centerArea.style.display = 'none';
          }
        }

        if (this.btnToggleSideEditor) {
          this.btnToggleSideEditor.style.display = 'inline-flex';
          this.btnToggleSideEditor.classList.toggle('active', this.isSideEditorOpenInChatMode);
        }
      } else {
        // IDEモード
        if (this.centerArea) {
          this.centerArea.style.display = 'flex';
          this.centerArea.style.flex = '1';
          this.centerArea.style.width = 'auto';
          this.centerArea.style.maxWidth = 'none';
          this.centerArea.style.minWidth = '0';
          this.centerArea.style.order = '1';
          this.centerArea.style.borderLeft = 'none';
        }

        this.aiPanel.style.display = this.isAIPanelOpen ? 'flex' : 'none';
        this.aiPanel.style.width = '420px';
        this.aiPanel.style.minWidth = '320px';
        this.aiPanel.style.flex = 'none';
        this.aiPanel.style.order = '2';
        this.aiPanel.style.borderLeft = '1px solid var(--se-border)';

        if (this.btnToggleSideEditor) {
          this.btnToggleSideEditor.style.display = 'none';
        }
      }
      this._updateAIContextBadge();
    }

    _buildAIPanelUI() {
      this.aiPanel = this._makeEl('div', {
        width: '420px', display: 'flex', flexDirection: 'column', background: 'var(--se-bg-secondary)',
        borderLeft: '1px solid var(--se-border)', overflow: 'hidden', position: 'relative'
      });

      // ヘッダーバー (ChatGPT / Cursor風)
      const aiHeader = this._makeEl('div', {
        padding: '12px 18px', background: 'var(--se-bg-tertiary)', borderBottom: '1px solid var(--se-border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: '0'
      });

      const aiTitleGroup = this._makeEl('div', { display: 'flex', alignItems: 'center', gap: '8px' });
      const aiStar = this._makeEl('span', { color: 'var(--se-accent-2)', fontSize: '16px' }); aiStar.textContent = '✨';
      const aiTxt = this._makeEl('span', {
        fontSize: '14px', fontWeight: '800', background: 'linear-gradient(135deg, #7c6cf0, #e056fd)',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent'
      });
      aiTxt.textContent = 'Gemini Co-pilot';
      aiTitleGroup.appendChild(aiStar);
      aiTitleGroup.appendChild(aiTxt);

      const aiHeaderActions = this._makeEl('div', { display: 'flex', alignItems: 'center', gap: '6px' });

      // 対話メインモード時の「エディタ表示」トグルボタン
      this.btnToggleSideEditor = this._makeEl('button', {
        className: 'se-mode-badge', display: 'none'
      });
      this.btnToggleSideEditor.textContent = '📝 エディタ表示';
      this.btnToggleSideEditor.onclick = () => {
        this.isSideEditorOpenInChatMode = !this.isSideEditorOpenInChatMode;
        this._setUIMode(this.uiMode);
      };

      const btnNewChat = this._makeEl('button', {
        background: 'transparent', border: 'none', color: 'var(--se-text-secondary)',
        cursor: 'pointer', padding: '5px 8px', borderRadius: '4px', fontSize: '13px',
        display: 'flex', alignItems: 'center', gap: '4px'
      });
      btnNewChat.title = '新しいチャットを開始';
      btnNewChat.textContent = '✏️';
      btnNewChat.onclick = () => this._startNewChat();

      const btnSettings = this._makeEl('button', {
        background: 'transparent', border: 'none', color: 'var(--se-text-secondary)',
        cursor: 'pointer', padding: '5px 8px', borderRadius: '4px', fontSize: '13px',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      });
      btnSettings.title = 'AI設定';
      btnSettings.textContent = '⚙️';
      btnSettings.onclick = () => this._showSettingsModal();

      const btnCloseAI = this._makeEl('button', {
        background: 'transparent', border: 'none', color: 'var(--se-text-secondary)',
        cursor: 'pointer', padding: '5px 8px', borderRadius: '4px', fontSize: '13px'
      });
      btnCloseAI.textContent = '✕';
      btnCloseAI.onclick = () => {
        if (this.uiMode === 'chat') {
          this._setUIMode('ide');
        } else {
          this._toggleAIPanel();
        }
      };

      aiHeaderActions.appendChild(this.btnToggleSideEditor);
      aiHeaderActions.appendChild(btnNewChat);
      aiHeaderActions.appendChild(btnSettings);
      aiHeaderActions.appendChild(btnCloseAI);
      aiHeader.appendChild(aiTitleGroup);
      aiHeader.appendChild(aiHeaderActions);

      // チャットメッセージタイムライン領域
      this.aiChatMessagesArea = this._makeEl('div', {
        flex: '1', overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column',
        gap: '16px', background: 'var(--se-bg-secondary)'
      });

      // エラー修復クイックバナー (エラー時に出現)
      this.aiErrorBanner = this._makeEl('div', {
        display: 'none', margin: '0 20px 8px 20px', padding: '10px 14px', background: 'rgba(255,107,107,0.12)',
        border: '1px solid rgba(255,107,107,0.3)', borderRadius: 'var(--se-radius-sm)',
        alignItems: 'center', justifyContent: 'space-between', gap: '10px', fontSize: '12px'
      });
      const errTxt = this._makeEl('span', { color: 'var(--se-error)', fontWeight: '600' });
      errTxt.textContent = '⚠️ コンパイルエラーが検出されました';
      const btnFixBanner = this._makeEl('button', {
        background: 'var(--se-error)', border: 'none', color: '#fff', padding: '4px 10px',
        borderRadius: '4px', fontSize: '11px', fontWeight: '700', cursor: 'pointer'
      });
      btnFixBanner.textContent = '✨ AIで修復する';
      btnFixBanner.onclick = () => this._sendFixErrorPrompt();
      this.aiErrorBanner.appendChild(errTxt);
      this.aiErrorBanner.appendChild(btnFixBanner);

      // 下部 フローティング入力バーコンテナ (ChatGPT風)
      const aiInputContainer = this._makeEl('div', {
        padding: '10px 18px 14px 18px', background: 'var(--se-bg-secondary)', borderTop: '1px solid var(--se-border)',
        display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: '0', boxSizing: 'border-box', width: '100%'
      });

      // 📎 参照中コンテキスト表示バー (aiContextBar)
      this.aiContextBar = this._makeEl('div', {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '5px 10px', background: 'rgba(124,108,240,0.08)',
        border: '1px solid rgba(124,108,240,0.2)', borderRadius: '12px',
        fontSize: '12px', boxSizing: 'border-box', width: '100%',
        transition: 'var(--se-transition)'
      });

      const ctxLeft = this._makeEl('div', { display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', minWidth: '0' });
      const ctxIcon = this._makeEl('span', { fontSize: '13px', flexShrink: '0' });
      ctxIcon.textContent = '📎';
      const ctxLabel = this._makeEl('span', { color: 'var(--se-text-secondary)', fontWeight: '600', flexShrink: '0', fontSize: '11.5px' });
      ctxLabel.textContent = '参照中:';
      this.aiContextText = this._makeEl('span', {
        color: 'var(--se-accent-2)', fontWeight: '700', fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      });
      ctxLeft.appendChild(ctxIcon);
      ctxLeft.appendChild(ctxLabel);
      ctxLeft.appendChild(this.aiContextText);

      this.btnToggleContext = this._makeEl('button', {
        background: 'transparent', border: 'none', color: 'var(--se-text-muted)',
        cursor: 'pointer', fontSize: '11px', padding: '2px 6px', borderRadius: '4px',
        flexShrink: '0', transition: 'var(--se-transition)'
      });
      this.btnToggleContext.textContent = '✕ 解除';
      this.btnToggleContext.title = '現在のシェーダーコードを参照せずに質問・作成します';
      this.btnToggleContext.onclick = () => {
        this.isContextIgnored = !this.isContextIgnored;
        this._updateAIContextBadge();
      };

      this.aiContextBar.appendChild(ctxLeft);
      this.aiContextBar.appendChild(this.btnToggleContext);

      const inputBar = this._makeEl('div', {
        display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--se-bg-tertiary)',
        border: '1px solid rgba(255,255,255,0.15)', borderRadius: '24px', padding: '6px 12px',
        boxSizing: 'border-box', width: '100%', transition: 'var(--se-transition)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.25)'
      });
      inputBar.className = 'se-chat-input-bar';

      // ＋ アクションボタン
      const btnPlus = this._makeEl('button', {
        background: 'transparent', border: 'none', color: 'var(--se-text-secondary)',
        fontSize: '18px', cursor: 'pointer', padding: '4px 6px', display: 'flex', alignItems: 'center',
        justifyContent: 'center', transition: 'var(--se-transition)', flexShrink: '0', lineHeight: '1'
      });
      btnPlus.textContent = '＋';
      btnPlus.title = 'クイックアクション / プリセット';
      btnPlus.onmouseenter = () => { btnPlus.style.color = 'var(--se-text-primary)'; };
      btnPlus.onmouseleave = () => { btnPlus.style.color = 'var(--se-text-secondary)'; };
      btnPlus.onclick = (e) => this._showQuickActionMenu(e);

      // テキストエリア
      this.aiChatInput = document.createElement('textarea');
      this.aiChatInput.className = 'se-chat-textarea';
      Object.assign(this.aiChatInput.style, {
        flex: '1', minWidth: '0', background: 'transparent', border: 'none', outline: 'none',
        color: 'var(--se-text-primary)', fontFamily: 'var(--se-font-ui)',
        fontSize: '13.5px', lineHeight: '1.4', resize: 'none',
        maxHeight: '120px', minHeight: '22px', height: '24px', padding: '4px 6px',
        boxSizing: 'border-box', overflow: 'hidden', overflowY: 'hidden',
        scrollbarWidth: 'none'
      });
      this.aiChatInput.placeholder = 'シェーダーの生成・修正・質問を入力 (Shift+Enterで改行)...';
      this.aiChatInput.rows = 1;

      this.aiChatInput.addEventListener('input', () => {
        this.aiChatInput.style.height = 'auto';
        const newH = Math.min(this.aiChatInput.scrollHeight, 120);
        this.aiChatInput.style.height = newH + 'px';
        this.aiChatInput.style.overflowY = this.aiChatInput.scrollHeight > 120 ? 'auto' : 'hidden';
      });

      this.aiChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this._sendChatMessage();
        }
      });

      // 送信ボタン (↑)
      this.btnSendChat = this._makeEl('button', {
        width: '32px', height: '32px', minWidth: '32px', borderRadius: '50%', border: 'none',
        background: 'var(--se-accent)', color: '#fff', display: 'flex', alignItems: 'center',
        justifyContent: 'center', cursor: 'pointer', transition: 'var(--se-transition)',
        fontSize: '16px', fontWeight: 'bold', flexShrink: '0', padding: '0',
        boxShadow: '0 2px 8px rgba(124,108,240,0.4)'
      });
      this.btnSendChat.className = 'se-send-btn';
      this.btnSendChat.title = '送信 (Enter)';
      this.btnSendChat.textContent = '↑';
      this.btnSendChat.onclick = () => this._sendChatMessage();

      inputBar.appendChild(btnPlus);
      inputBar.appendChild(this.aiChatInput);
      inputBar.appendChild(this.btnSendChat);

      const disclaimer = this._makeEl('div', {
        fontSize: '11px', color: 'var(--se-text-muted)', textAlign: 'center', lineHeight: '1.3'
      });
      disclaimer.textContent = 'Geminiは間違ったコードを出力することがあります。適用前にご確認ください。';

      aiInputContainer.appendChild(this.aiContextBar);
      aiInputContainer.appendChild(inputBar);
      aiInputContainer.appendChild(disclaimer);

      this.aiPanel.appendChild(aiHeader);
      this.aiPanel.appendChild(this.aiChatMessagesArea);
      this.aiPanel.appendChild(this.aiErrorBanner);
      this.aiPanel.appendChild(aiInputContainer);

      // 初期メッセージ描画
      this._renderChatMessages();

      // UIモードの適用
      this._setUIMode(this.uiMode);
    }

    _toggleAIPanel(forceState = null) {
      this.isAIPanelOpen = forceState !== null ? forceState : !this.isAIPanelOpen;
      if (this.uiMode === 'chat') {
        if (!this.isAIPanelOpen) {
          this._setUIMode('ide');
        }
      } else {
        if (this.aiPanel) {
          this.aiPanel.style.display = this.isAIPanelOpen ? 'flex' : 'none';
        }
      }
      this._updateAIContextBadge();
    }

    _openAIGenerator() {
      this.isAIPanelOpen = true;
      if (this.uiMode === 'chat') {
        this._setUIMode('chat');
      } else {
        if (this.aiPanel) this.aiPanel.style.display = 'flex';
      }
      if (this.aiChatInput) {
        this.aiChatInput.focus();
      }
    }

    _startNewChat() {
      this.chatMessages = [];
      this._renderChatMessages();
      this._showToast('新しいチャットを開始しました');
      if (this.aiChatInput) this.aiChatInput.focus();
    }

    _renderChatMessages() {
      if (!this.aiChatMessagesArea) return;
      this.aiChatMessagesArea.replaceChildren();

      // メッセージが空の場合は ChatGPT風ウェルカム画面を表示
      if (this.chatMessages.length === 0) {
        const welcome = this._makeEl('div', {
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          margin: 'auto 0', padding: '20px 10px', gap: '16px', textAlign: 'center'
        });

        const iconBox = this._makeEl('div', {
          width: '56px', height: '56px', borderRadius: '16px', background: 'var(--se-accent-gradient)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px', color: '#fff',
          boxShadow: '0 4px 20px rgba(124,108,240,0.4)'
        });
        iconBox.textContent = '✨';

        const title = this._makeEl('div', { fontSize: '20px', fontWeight: '800', color: 'var(--se-text-primary)' });
        title.textContent = '何をお手伝いしましょうか？';

        const subtitle = this._makeEl('div', { fontSize: '13px', color: 'var(--se-text-secondary)', maxWidth: '340px', lineHeight: '1.5' });
        subtitle.textContent = '作りたいエフェクトや修正したい点を自由に入力してください。AIがGLSLコードを即座に作成・修復します。';

        const chipsGrid = this._makeEl('div', {
          display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', maxWidth: '380px', marginTop: '8px'
        });

        const suggestions = [
          { text: '🌊 水面の波紋エフェクト', prompt: '水面のように波打つエフェクト。時間経過で青とシアンの光が揺れるシェーダーを作って。' },
          { text: '⚡ CRT走査線とノイズ', prompt: 'レトロなブラウン管テレビのような走査線と微弱なグリッチノイズのシェーダーを作って。' },
          { text: '🛠️ エラーを修復する', action: 'fix' },
          { text: '📖 コードの仕組みを解説', action: 'explain' }
        ];

        suggestions.forEach(s => {
          const chip = this._makeEl('div', { className: 'se-pill-chip' });
          chip.textContent = s.text;
          chip.onclick = () => {
            if (s.action === 'fix') {
              this._sendFixErrorPrompt();
            } else if (s.action === 'explain') {
              this._sendExplainPrompt();
            } else {
              this.aiChatInput.value = s.prompt;
              this._sendChatMessage();
            }
          };
          chipsGrid.appendChild(chip);
        });

        welcome.appendChild(iconBox);
        welcome.appendChild(title);
        welcome.appendChild(subtitle);
        welcome.appendChild(chipsGrid);
        this.aiChatMessagesArea.appendChild(welcome);
        return;
      }

      // チャット履歴のレンダリング
      this.chatMessages.forEach(msg => {
        const wrap = this._makeEl('div', { className: 'se-chat-msg' });

        if (msg.role === 'user') {
          const bubble = this._makeEl('div', { className: 'se-chat-user-bubble' });
          bubble.textContent = msg.text;
          wrap.appendChild(bubble);
        } else {
          const bubble = this._makeEl('div', { className: 'se-chat-model-bubble' });
          
          const modelHeader = this._makeEl('div', { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' });
          const star = this._makeEl('span', { color: 'var(--se-accent-2)', fontSize: '14px' }); star.textContent = '✨';
          const name = this._makeEl('span', { fontSize: '12px', fontWeight: '700', color: 'var(--se-text-secondary)' });
          name.textContent = 'Gemini';
          modelHeader.appendChild(star);
          modelHeader.appendChild(name);
          bubble.appendChild(modelHeader);

          // Markdown ＆ コードブロックのレンダリング
          this._renderMarkdownAndCode(msg.text, bubble);
          wrap.appendChild(bubble);
        }

        this.aiChatMessagesArea.appendChild(wrap);
      });

      // 最下部へスクロール
      this.aiChatMessagesArea.scrollTop = this.aiChatMessagesArea.scrollHeight;
    }

    _renderInlineMarkdown(text, parentEl) {
      if (!text) return;
      const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
      let lastIdx = 0;
      let match;

      while ((match = tokenRegex.exec(text)) !== null) {
        if (match.index > lastIdx) {
          parentEl.appendChild(document.createTextNode(text.substring(lastIdx, match.index)));
        }

        const raw = match[0];
        if (raw.startsWith('`') && raw.endsWith('`')) {
          const codeEl = this._makeEl('code', {
            background: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: '4px',
            fontFamily: 'var(--se-font-code)', fontSize: '0.88em', color: 'var(--se-accent-2)'
          });
          codeEl.textContent = raw.slice(1, -1);
          parentEl.appendChild(codeEl);
        } else if (raw.startsWith('**') && raw.endsWith('**')) {
          const strongEl = this._makeEl('strong', { color: 'var(--se-text-primary)', fontWeight: '700' });
          strongEl.textContent = raw.slice(2, -2);
          parentEl.appendChild(strongEl);
        } else if (raw.startsWith('*') && raw.endsWith('*')) {
          const emEl = this._makeEl('em', { fontStyle: 'italic' });
          emEl.textContent = raw.slice(1, -1);
          parentEl.appendChild(emEl);
        } else if (raw.startsWith('[') && raw.includes('](')) {
          const m = raw.match(/\[([^\]]+)\]\(([^)]+)\)/);
          if (m) {
            const aEl = this._makeEl('a', { color: 'var(--se-accent-2)', textDecoration: 'underline' });
            aEl.textContent = m[1];
            aEl.href = m[2];
            aEl.target = '_blank';
            aEl.rel = 'noopener noreferrer';
            parentEl.appendChild(aEl);
          }
        }

        lastIdx = tokenRegex.lastIndex;
      }

      if (lastIdx < text.length) {
        parentEl.appendChild(document.createTextNode(text.substring(lastIdx)));
      }
    }

    _renderMarkdownToDOM(markdownText) {
      const container = this._makeEl('div', {
        lineHeight: '1.65', color: 'var(--se-text-primary)', fontSize: '13.5px', wordBreak: 'break-word'
      });

      const lines = markdownText.split('\n');
      let currentList = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) {
          currentList = null;
          continue;
        }

        // 区切り線
        if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
          currentList = null;
          const hr = this._makeEl('hr', {
            border: 'none', borderTop: '1px solid var(--se-border)', margin: '12px 0'
          });
          container.appendChild(hr);
          continue;
        }

        // 見出し
        if (trimmed.startsWith('#')) {
          currentList = null;
          let level = 0;
          while (level < trimmed.length && trimmed[level] === '#') level++;
          const hText = trimmed.substring(level).trim();
          const tag = level <= 2 ? 'h3' : 'h4';
          const size = level === 1 ? '16px' : (level === 2 ? '15px' : '14px');
          const hEl = this._makeEl(tag, {
            margin: '12px 0 6px 0', fontSize: size, fontWeight: '700',
            color: 'var(--se-text-primary)'
          });
          this._renderInlineMarkdown(hText, hEl);
          container.appendChild(hEl);
          continue;
        }

        // リスト (- or * or 1.)
        const listMatch = trimmed.match(/^([-*]|\d+\.)\s+(.+)$/);
        if (listMatch) {
          const itemText = listMatch[2];
          if (!currentList) {
            currentList = this._makeEl('ul', {
              margin: '6px 0', paddingLeft: '20px', listStyleType: listMatch[1].includes('.') ? 'decimal' : 'disc'
            });
            container.appendChild(currentList);
          }
          const li = this._makeEl('li', { margin: '3px 0' });
          this._renderInlineMarkdown(itemText, li);
          currentList.appendChild(li);
          continue;
        }

        currentList = null;

        // 引用ブロック (> )
        if (trimmed.startsWith('>')) {
          const quoteText = trimmed.substring(1).trim();
          const bq = this._makeEl('blockquote', {
            margin: '6px 0', padding: '6px 12px', borderLeft: '3px solid var(--se-accent)',
            background: 'rgba(124,108,240,0.06)', borderRadius: '0 4px 4px 0',
            color: 'var(--se-text-secondary)'
          });
          this._renderInlineMarkdown(quoteText, bq);
          container.appendChild(bq);
          continue;
        }

        // 通常の段落 (p)
        const p = this._makeEl('p', { margin: '4px 0' });
        this._renderInlineMarkdown(line, p);
        container.appendChild(p);
      }

      return container;
    }

    _renderMarkdownAndCode(rawText, container) {
      const parts = [];
      const codeRegex = /```([a-zA-Z0-9_\-\.]*)\n([\s\S]*?)```/g;
      let lastIndex = 0;
      let match;

      while ((match = codeRegex.exec(rawText)) !== null) {
        if (match.index > lastIndex) {
          parts.push({ type: 'text', content: rawText.substring(lastIndex, match.index) });
        }
        parts.push({ type: 'code', lang: match[1].toLowerCase() || 'glsl', code: match[2].trim() });
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < rawText.length) {
        parts.push({ type: 'text', content: rawText.substring(lastIndex) });
      }

      parts.forEach(p => {
        if (p.type === 'text') {
          const textEl = this._renderMarkdownToDOM(p.content.trim());
          container.appendChild(textEl);
        } else if (p.type === 'code') {
          const card = this._makeEl('div', { className: 'se-code-card' });

          const isFrag = p.lang.includes('frag') || p.lang.includes('glsl') || p.code.includes('gl_FragColor');
          const isVert = p.lang.includes('vert') || p.code.includes('gl_Position');
          const isJS = p.lang.includes('js') || p.lang.includes('javascript') || p.code.includes('onInit') || p.code.includes('onFrame');

          let label = 'GLSL CODE';
          let targetType = 'frag';
          if (isVert) { label = 'VERTEX SHADER'; targetType = 'vert'; }
          else if (isFrag) { label = 'FRAGMENT SHADER'; targetType = 'frag'; }
          else if (isJS) { label = 'JAVASCRIPT'; targetType = 'js'; }

          const cardHeader = this._makeEl('div', { className: 'se-code-card-header' });
          const langLabel = this._makeEl('span', {}); langLabel.textContent = label;
          const btnCopy = this._makeEl('button', {
            background: 'transparent', border: 'none', color: 'var(--se-text-secondary)',
            fontSize: '11px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
          });
          btnCopy.textContent = '📋 コピー';
          btnCopy.onclick = () => {
            navigator.clipboard.writeText(p.code);
            btnCopy.textContent = '✓ コピー完了';
            setTimeout(() => { btnCopy.textContent = '📋 コピー'; }, 2000);
          };
          cardHeader.appendChild(langLabel);
          cardHeader.appendChild(btnCopy);

          const cardBody = document.createElement('pre');
          cardBody.className = 'se-code-card-body';
          const codeTag = document.createElement('code');
          codeTag.className = `language-${p.lang || 'glsl'}`;
          codeTag.textContent = p.code;
          cardBody.appendChild(codeTag);

          const cardFooter = this._makeEl('div', { className: 'se-code-card-footer' });
          
          const btnApplyText = this.autoApply ? '✓ 自動適用済み (再適用)' : '✨ エディタに即時適用';
          const btnApplyColor = this.autoApply ? 'rgba(46,213,115,0.18)' : 'var(--se-accent)';
          const btnApply = this._createBtn(btnApplyText, btnApplyColor, () => {
            this._applyCodeToEditor(targetType, p.code);
          }, 'check');
          btnApply.style.padding = '5px 12px';
          btnApply.style.fontSize = '12px';
          if (this.autoApply) {
            btnApply.style.color = 'var(--se-success)';
            btnApply.style.border = '1px solid rgba(46,213,115,0.4)';
          }

          const btnNew = this._createBtn('＋ 新規作成', 'var(--se-bg-tertiary)', () => {
            this._createNewShaderWithCode(p.code, targetType);
          }, 'add');
          btnNew.style.padding = '5px 12px';
          btnNew.style.fontSize = '12px';

          cardFooter.appendChild(btnNew);
          cardFooter.appendChild(btnApply);

          card.appendChild(cardHeader);
          card.appendChild(cardBody);
          card.appendChild(cardFooter);
          container.appendChild(card);
        }
      });
    }

    _applyCodeToEditor(type, code) {
      if (type === 'frag') {
        this.fragmentEditor.value = code;
      } else if (type === 'vert') {
        this.vertexEditor.value = code;
      } else if (type === 'js') {
        this.jsEditor.value = code;
      }
      this._autoSaveShader();
      this._showToast('エディタにコードを即時反映しました！');
      if (this.fragmentPanel) this.fragmentPanel.updateHighlight();
      if (this.vertexPanel) this.vertexPanel.updateHighlight();
      if (this.jsPanel) this.jsPanel.updateHighlight();
    }

    _createNewShaderDirect(suggestedName, fragCode, vertCode, jsCode) {
      let name = (suggestedName || '新規シェーダー').trim();
      let c = 2;
      const baseName = name;
      while (this.shaderManager.shaders.has(name)) {
        name = `${baseName} ${c++}`;
      }

      const defaultV = `attribute vec2 a_position;\nattribute vec2 a_texCoord;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_Position = vec4(a_position, 0.0, 1.0);\n  v_texCoord = a_texCoord;\n}`;
      const defaultF = `precision mediump float;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_FragColor = texture2D(u_texture, v_texCoord);\n}`;
      const defaultJ = `// 初期化時に1回呼ばれる\nfunction onInit(api) {\n  \n}\n\n// 毎フレーム呼ばれる\nfunction onFrame(api) {\n  \n}`;

      const vSource = vertCode || defaultV;
      const fSource = fragCode || defaultF;
      const jSource = (jsCode !== undefined && jsCode !== null && jsCode.trim() !== '') ? jsCode : defaultJ;

      // shaderManagerに登録
      const res = this.shaderManager.addShader(name, vSource, fSource, jSource);
      if (res && res.success) {
        // アクティブ化してレンダラーを確実に起動・同期描画
        this.shaderManager.setEnabled(name, true);
        this.shaderManager.saveShadersToProject();
        this.loadShader(name);
        if (this.fragmentPanel) this.fragmentPanel.updateHighlight();
        if (this.vertexPanel) this.vertexPanel.updateHighlight();
        if (this.jsPanel) this.jsPanel.updateHighlight();
        return name;
      }
      return null;
    }

    _createNewIntegratedShaderDirect(suggestedName, childrenList = []) {
      let name = (suggestedName || '新規統合シェーダー').trim();
      let c = 2;
      const baseName = name;
      while (this.shaderManager.shaders.has(name)) {
        name = `${baseName} ${c++}`;
      }

      const defaultV = `attribute vec2 a_position;\nattribute vec2 a_texCoord;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_Position = vec4(a_position, 0.0, 1.0);\n  v_texCoord = a_texCoord;\n}`;
      const defaultF = `precision mediump float;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_FragColor = texture2D(u_texture, v_texCoord);\n}`;

      const processedChildren = (childrenList || []).map((ch, idx) => {
        const cName = (ch.name || `子シェーダー ${idx + 1}`).trim();
        const vSrc = ch.vert || defaultV;
        const fSrc = ch.frag || defaultF;
        const jSrc = ch.js || '';
        let progData = { program: null, uniforms: {}, constDefaults: {} };
        try {
          progData = this.shaderManager.createProgram(vSrc, fSrc);
        } catch (e) {
          console.warn('[ShaderManager] child compile error:', e);
        }
        let jsState = { initialized: false, module: null };
        if (jSrc) jsState.module = this.shaderManager._compileJs(jSrc);

        return {
          name: cName,
          vertexSource: vSrc,
          fragmentSource: fSrc,
          jsSource: jSrc,
          jsState,
          ...progData,
          uniformValues: Object.assign({}, progData.constDefaults || {}),
          isIntegrated: false,
          children: [],
          activeChildren: []
        };
      });

      const activeChildNames = processedChildren.map(c => c.name);

      const res = this.shaderManager.addShader(name, '', '', '', true, processedChildren, activeChildNames);
      if (res && res.success) {
        // アクティブ化してレンダラーを確実に起動・同期描画
        this.shaderManager.setEnabled(name, true);
        this.shaderManager.saveShadersToProject();
        this.loadShader(name);
        this._updateList();
        this._updateAIContextBadge();
        return name;
      }
      return null;
    }

    _addChildShaderToCurrentIntegrated(parentName, childObj) {
      const parent = this.shaderManager.getShader(parentName);
      if (!parent || !parent.isIntegrated) return null;

      let cName = (childObj.name || '新規子シェーダー').trim();
      let c = 2;
      const baseName = cName;
      while (parent.children && parent.children.some(ch => ch.name === cName)) {
        cName = `${baseName} ${c++}`;
      }

      const defaultV = `attribute vec2 a_position;\nattribute vec2 a_texCoord;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_Position = vec4(a_position, 0.0, 1.0);\n  v_texCoord = a_texCoord;\n}`;
      const defaultF = `precision mediump float;\nuniform sampler2D u_texture;\nvarying vec2 v_texCoord;\n\nvoid main() {\n  gl_FragColor = texture2D(u_texture, v_texCoord);\n}`;

      const vSrc = childObj.vert || defaultV;
      const fSrc = childObj.frag || defaultF;
      const jSrc = childObj.js || '';
      let progData = { program: null, uniforms: {}, constDefaults: {} };
      try {
        progData = this.shaderManager.createProgram(vSrc, fSrc);
      } catch (e) {
        console.warn('[ShaderManager] child compile error:', e);
      }
      let jsState = { initialized: false, module: null };
      if (jSrc) jsState.module = this.shaderManager._compileJs(jSrc);

      const newChild = {
        name: cName,
        vertexSource: vSrc,
        fragmentSource: fSrc,
        jsSource: jSrc,
        jsState,
        ...progData,
        uniformValues: Object.assign({}, progData.constDefaults || {}),
        isIntegrated: false,
        children: [],
        activeChildren: []
      };

      if (!parent.children) parent.children = [];
      parent.children.push(newChild);
      if (!parent.activeChildren) parent.activeChildren = [];
      if (!parent.activeChildren.includes(cName)) parent.activeChildren.push(cName);

      this.shaderManager.saveShadersToProject();
      this.shaderManager.requestImmediateRedraw();
      this._updateIntegratedList();
      this._updateList();
      this._updateAIContextBadge();
      return cName;
    }

    _createNewShaderWithCode(code, type) {
      const f = type === 'frag' ? code : null;
      const v = type === 'vert' ? code : null;
      const j = type === 'js' ? code : null;
      const createdName = this._createNewShaderDirect('新規シェーダー', f, v, j);
      if (createdName) {
        this._showToast(`「${createdName}」を新規作成しました！`);
      }
    }

    _showQuickActionMenu(e) {
      document.querySelectorAll('.se-quick-menu').forEach(el => el.remove());
      const menu = this._makeEl('div', {
        position: 'absolute', background: 'var(--se-bg-tertiary)', border: '1px solid var(--se-border)',
        borderRadius: 'var(--se-radius)', padding: '6px', zIndex: '100015', boxShadow: 'var(--se-shadow)',
        display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '200px'
      });
      menu.className = 'se-quick-menu';

      const addItem = (icon, text, onClick) => {
        const item = this._makeEl('div', {
          padding: '8px 12px', borderRadius: 'var(--se-radius-sm)', cursor: 'pointer',
          color: 'var(--se-text-primary)', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px',
          transition: 'var(--se-transition)'
        });
        item.textContent = `${icon} ${text}`;
        item.onmouseenter = () => item.style.background = 'var(--se-bg-hover)';
        item.onmouseleave = () => item.style.background = 'transparent';
        item.onclick = () => { onClick(); menu.remove(); };
        menu.appendChild(item);
      };

      addItem('🛠️', '現在のエラーを修復する', () => this._sendFixErrorPrompt());
      addItem('📖', '現在のコードを解説する', () => this._sendExplainPrompt());
      addItem('📁', '波紋＋色調補正の統合シェーダー', () => { this.aiChatInput.value = '水面の波紋とコントラスト色調補正を組み合わせた統合シェーダーを作成して'; this._sendChatMessage(); });
      addItem('🌊', '水面の波紋エフェクト', () => { this.aiChatInput.value = '水面の波紋エフェクトを作って'; this._sendChatMessage(); });
      addItem('⚡', 'CRT走査線とノイズ', () => { this.aiChatInput.value = 'CRT走査線とグリッチノイズのシェーダーを作って'; this._sendChatMessage(); });
      addItem('🌈', 'サイバーパンク風ネオン発光', () => { this.aiChatInput.value = 'サイバーパンク風のネオン発光シェーダーを作って'; this._sendChatMessage(); });

      const rect = e.target.getBoundingClientRect();
      Object.assign(menu.style, { left: rect.left + 'px', bottom: (window.innerHeight - rect.top + 8) + 'px' });
      document.body.appendChild(menu);

      const close = (ev) => { if (!menu.contains(ev.target) && ev.target !== e.target) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    }

    _sendFixErrorPrompt() {
      const err = this._lastCompilationError || 'エラーを点検して修復してください。';
      this.aiChatInput.value = `現在発生している以下のエラーを解析して修正コードを提供してください:\n${err}`;
      this._sendChatMessage();
    }

    _getCurrentShaderData() {
      if (this.currentChildShaderParent) {
        const parent = this.shaderManager.getShader(this.currentChildShaderParent);
        const child = parent && parent.children ? parent.children.find(c => c.name === this.currentChildShaderName) : null;
        return {
          name: this.currentChildShaderName || '子シェーダー',
          parentName: this.currentChildShaderParent,
          isChildShader: true,
          isIntegrated: false,
          vertexSource: this.vertexEditor ? this.vertexEditor.value : (child ? child.vertexSource : ''),
          fragmentSource: this.fragmentEditor ? this.fragmentEditor.value : (child ? child.fragmentSource : ''),
          jsSource: this.jsEditor ? this.jsEditor.value : (child ? child.jsSource : '')
        };
      }

      if (this.currentShader) {
        const shader = this.shaderManager.getShader(this.currentShader);
        if (shader && shader.isIntegrated) {
          return {
            name: this.currentShader,
            isIntegrated: true,
            isChildShader: false,
            activeChildren: shader.activeChildren || [],
            children: (shader.children || []).map(c => ({
              name: c.name,
              vertexSource: c.vertexSource || '',
              fragmentSource: c.fragmentSource || '',
              jsSource: c.jsSource || '',
              active: shader.activeChildren ? shader.activeChildren.includes(c.name) : true
            }))
          };
        }
      }

      return {
        name: this.currentShader || (this.nameInput ? this.nameInput.value : '') || '新規シェーダー',
        isIntegrated: false,
        isChildShader: false,
        vertexSource: this.vertexEditor ? this.vertexEditor.value : '',
        fragmentSource: this.fragmentEditor ? this.fragmentEditor.value : '',
        jsSource: this.jsEditor ? this.jsEditor.value : ''
      };
    }

    _extractCodeBlocks(rawText) {
      const codeRegex = /```([a-zA-Z0-9_\-\.]*)\n([\s\S]*?)```/g;
      let match;
      let frag = null;
      let vert = null;
      let js = null;

      while ((match = codeRegex.exec(rawText)) !== null) {
        const lang = (match[1] || '').toLowerCase();
        const code = match[2].trim();

        if (lang.includes('vert') || (!vert && code.includes('a_position') && code.includes('gl_Position'))) {
          vert = code;
        } else if (lang.includes('js') || lang.includes('javascript') || code.includes('onInit') || code.includes('onFrame')) {
          js = code;
        } else if (lang.includes('frag') || lang.includes('glsl') || code.includes('gl_FragColor')) {
          frag = code;
        }
      }

      return { frag, vert, js };
    }

    // 複数子シェーダーを含む統合シェーダーの構造を解析
    _extractMultipleShaderSections(rawText) {
      const sections = [];
      const codeRegex = /```([a-zA-Z0-9_\-\.]*)\n([\s\S]*?)```/g;
      let match;
      let lastEnd = 0;
      const rawBlocks = [];

      while ((match = codeRegex.exec(rawText)) !== null) {
        const preText = rawText.substring(lastEnd, match.index);
        const lang = (match[1] || '').toLowerCase();
        const code = match[2].trim();
        lastEnd = match.index + match[0].length;
        rawBlocks.push({ preText, lang, code });
      }

      if (rawBlocks.length === 0) return [];

      let currentSection = null;

      rawBlocks.forEach((block, idx) => {
        // 前のテキストから子シェーダー名を抽出
        const nameMatch = block.preText.match(/(?:###|####|##)?\s*(?:子シェーダー|子|シェーダー|Shader|Pass)[:：\s]+([^\n\r]+)/i) ||
                          block.preText.match(/【(?:子シェーダー|子)[:：]?\s*([^】]+)】/i);
        
        let foundName = null;
        if (nameMatch && nameMatch[1]) {
          foundName = nameMatch[1].trim().replace(/[*_#`「」【】]/g, '').trim();
        }

        const isVert = block.lang.includes('vert') || block.code.includes('a_position');
        const isJs = block.lang.includes('js') || block.lang.includes('javascript') || block.code.includes('onInit');
        const isFrag = !isVert && !isJs;

        if (foundName || !currentSection || (isFrag && currentSection.frag)) {
          // 新しい子シェーダーセクションを開始
          currentSection = {
            name: foundName || `子シェーダー ${sections.length + 1}`,
            frag: null,
            vert: null,
            js: null
          };
          sections.push(currentSection);
        }

        if (isVert) currentSection.vert = block.code;
        else if (isJs) currentSection.js = block.code;
        else if (isFrag) currentSection.frag = block.code;
      });

      return sections.filter(s => s.frag || s.vert || s.js);
    }

    _extractShaderNameFromResponse(rawText, userPrompt) {
      // 1. 回答テキストから「統合シェーダー名: 〇〇」または「シェーダー名: 〇〇」を抽出
      const patterns = [
        /(?:###|##|#)?\s*(?:統合シェーダー名|統合名)[:：]\s*([^\n\r]+)/i,
        /【(?:統合シェーダー名|統合シェーダー)】[:：]?\s*([^\n\r]+)/i,
        /(?:###|##|#)?\s*(?:シェーダー名|名前|タイトル|Name)[:：]\s*([^\n\r]+)/i,
        /【(?:シェーダー名|名前|タイトル)】[:：]?\s*([^\n\r]+)/i,
        /「([^」]+(?:シェーダー|エフェクト)?)」/i,
        /^#+\s*([^\n\r]+)/m
      ];

      for (const p of patterns) {
        const match = rawText.match(p);
        if (match && match[1]) {
          let name = match[1].trim().replace(/[*_#`「」【】]/g, '').trim();
          name = name.replace(/^(?:統合シェーダー名|統合名|シェーダー名|名前|タイトル|Name)[:：]\s*/i, '');
          if (name.length > 0 && name.length <= 20) {
            return name;
          }
        }
      }

      // 2. プロンプトから依頼語を削ぎ落としてシンプルな名前を生成
      const cleanPrompt = (userPrompt || '')
        .replace(/(?:を?作って(?:ください)?|を?作成(?:して)?|を?お願い(?:します)?|統合シェーダー|シェーダー|エフェクト|コード|glsl)/gi, '')
        .trim();

      if (cleanPrompt.length > 0 && cleanPrompt.length <= 15) {
        return cleanPrompt;
      }

      return '新規シェーダー';
    }

    _autoApplyGeneratedCode(extracted, userPrompt, rawResponse) {
      if (!this.autoApply) return false;
      if (!extracted.frag && !extracted.vert && !extracted.js) return false;

      const isIntegratedRequest = /(?:統合|マルチパス|結合|組み合わせ|integrated)/i.test(userPrompt || '') ||
                                  /(?:統合シェーダー名|### 統合)/i.test(rawResponse || '');
      const isExplicitNewRequest = /(?:新規|新しく|別(?:の|で)|別のシェーダー|新シェーダー|new)/i.test(userPrompt || '');
      const multiSections = this._extractMultipleShaderSections(rawResponse);

      // ケース1: 統合シェーダー全体の作成（複数子シェーダー、または統合指定時）
      if ((isIntegratedRequest || multiSections.length > 1) && !this.currentChildShaderParent) {
        const integratedName = this._extractShaderNameFromResponse(rawResponse, userPrompt);
        const childrenList = multiSections.length > 0 ? multiSections : [{ name: 'パス1', frag: extracted.frag, vert: extracted.vert, js: extracted.js }];
        const createdName = this._createNewIntegratedShaderDirect(integratedName, childrenList);
        if (createdName) {
          this._showToast(`✨ 統合シェーダー「${createdName}」(子: ${childrenList.length}件) を自動作成・適用しました！`);
          return true;
        }
      }

      // ケース2: 既存の統合シェーダー親を開いていて「子シェーダー追加」の要求
      if (this.currentShader && !this.currentChildShaderParent) {
        const parent = this.shaderManager.getShader(this.currentShader);
        if (parent && parent.isIntegrated) {
          const isAddChild = /(?:子シェーダー|追加|パス|追加して|新子)/i.test(userPrompt || '');
          if (isAddChild || multiSections.length > 0) {
            const sectionsToAdd = multiSections.length > 0 ? multiSections : [{ name: this._extractShaderNameFromResponse(rawResponse, userPrompt), frag: extracted.frag, vert: extracted.vert, js: extracted.js }];
            sectionsToAdd.forEach(ch => this._addChildShaderToCurrentIntegrated(this.currentShader, ch));
            this._showToast(`✨ 統合シェーダー「${this.currentShader}」に子シェーダーを追加しました！`);
            return true;
          }
        }
      }

      // ケース3: 既存の子シェーダーまたは単体シェーダーの編集・修復
      const hasActiveShader = !isExplicitNewRequest && !this.isContextIgnored && Boolean(this.currentShader || this.currentChildShaderParent);

      if (hasActiveShader) {
        if (extracted.frag) this.fragmentEditor.value = extracted.frag;
        if (extracted.vert) this.vertexEditor.value = extracted.vert;
        if (extracted.js) this.jsEditor.value = extracted.js;
        this._autoSaveShader();
        if (this.fragmentPanel) this.fragmentPanel.updateHighlight();
        if (this.vertexPanel) this.vertexPanel.updateHighlight();
        if (this.jsPanel) this.jsPanel.updateHighlight();
        this._showToast('✨ AIがコードをエディタに自動適用しました！');
        return true;
      } else {
        // ケース4: 新規単体シェーダーの自動作成
        const suggestedName = this._extractShaderNameFromResponse(rawResponse, userPrompt);
        const createdName = this._createNewShaderDirect(suggestedName, extracted.frag, extracted.vert, extracted.js);
        if (createdName) {
          this._updateList();
          this._updateAIContextBadge();
          this._showToast(`✨ 新規シェーダー「${createdName}」を自動作成・適用しました！`);
          return true;
        }
        return false;
      }
    }

    async _sendChatMessage() {
      const prompt = (this.aiChatInput.value || '').trim();
      if (!prompt) return;

      this.aiChatInput.value = '';
      this.aiChatInput.style.height = 'auto';
      this.btnSendChat.disabled = true;

      // ユーザーメッセージを追加
      this.chatMessages.push({ role: 'user', text: prompt, time: Date.now() });
      this._renderChatMessages();

      // ローディングインジケーターをタイムラインに追加
      const loadingWrap = this._makeEl('div', { className: 'se-chat-msg' });
      const loadingBubble = this._makeEl('div', { className: 'se-chat-model-bubble', display: 'flex', alignItems: 'center', gap: '6px' });
      const spinIcon = this._makeEl('span', { display: 'inline-block', animation: 'se-spin 1s linear infinite' });
      spinIcon.textContent = '✨';
      const spinText = document.createTextNode('Geminiが思考中...');
      loadingBubble.appendChild(spinIcon);
      loadingBubble.appendChild(spinText);
      loadingWrap.appendChild(loadingBubble);
      this.aiChatMessagesArea.appendChild(loadingWrap);
      this.aiChatMessagesArea.scrollTop = this.aiChatMessagesArea.scrollHeight;

      try {
        const currentData = this.isContextIgnored ? null : this._getCurrentShaderData();
        const responseText = await this.gemini.chat(this.chatMessages, currentData);
        loadingWrap.remove();

        const extracted = this._extractCodeBlocks(responseText);
        let isApplied = false;
        if (this.autoApply) {
          isApplied = this._autoApplyGeneratedCode(extracted, prompt, responseText);
        }

        this.chatMessages.push({ role: 'model', text: responseText, time: Date.now(), autoApplied: isApplied });
        this._renderChatMessages();
      } catch (err) {
        loadingWrap.remove();
        this._showToast(err.message, true);
        this.chatMessages.push({
          role: 'model',
          text: `⚠️ エラーが発生しました: ${err.message}\nAPIキーが設定されているかご確認ください。`
        });
        this._renderChatMessages();
      } finally {
        this.btnSendChat.disabled = false;
        if (this.aiChatInput) this.aiChatInput.focus();
      }
    }

    _showSettingsModal() {
      document.querySelectorAll('.se-settings-modal-overlay').forEach(el => el.remove());

      const overlay = this._makeEl('div', {
        position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        zIndex: '100020', display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'se-fade-in 0.2s ease-out'
      });
      overlay.className = 'se-settings-modal-overlay';

      const modal = this._makeEl('div', {
        width: '460px', background: 'var(--se-bg-secondary)', border: '1px solid var(--se-border)',
        borderRadius: 'var(--se-radius)', padding: '24px', display: 'flex', flexDirection: 'column',
        gap: '16px', boxShadow: 'var(--se-shadow)'
      });

      const modalHeader = this._makeEl('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
      const modalTitle = this._makeEl('div', { fontSize: '16px', fontWeight: '800', color: 'var(--se-text-primary)' });
      modalTitle.textContent = '⚙️ Gemini AI ＆ IDE 設定';
      const btnCloseModal = this._makeEl('button', { background: 'transparent', border: 'none', color: 'var(--se-text-secondary)', fontSize: '16px', cursor: 'pointer' });
      btnCloseModal.textContent = '✕';
      btnCloseModal.onclick = () => overlay.remove();
      modalHeader.appendChild(modalTitle);
      modalHeader.appendChild(btnCloseModal);

      // UIモード選択
      const modeGroup = this._makeEl('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
      const modeLabel = this._makeEl('label', { fontSize: '12px', fontWeight: '600', color: 'var(--se-text-primary)' });
      modeLabel.textContent = 'デフォルトのUIスタイル';
      const modeSelect = document.createElement('select');
      modeSelect.className = 'se-select';
      modeSelect.style.width = '100%';
      const optIde = document.createElement('option'); optIde.value = 'ide'; optIde.textContent = '◫ 標準IDEモード (エクスプローラー + エディタ + サイドAI)';
      const optChat = document.createElement('option'); optChat.value = 'chat'; optChat.textContent = '💬 Cursor風対話メインモード (チャット主導 + 連携エディタ)';
      if (this.uiMode === 'chat') optChat.selected = true; else optIde.selected = true;
      modeSelect.appendChild(optIde);
      modeSelect.appendChild(optChat);
      modeGroup.appendChild(modeLabel);
      modeGroup.appendChild(modeSelect);

      // APIキー入力
      const keyGroup = this._makeEl('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
      const keyLabel = this._makeEl('label', { fontSize: '12px', fontWeight: '600', color: 'var(--se-text-primary)' });
      keyLabel.textContent = 'Gemini API キー';
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.className = 'se-input';
      keyInput.style.width = '100%';
      keyInput.value = this.gemini.getApiKey();
      keyInput.placeholder = 'AIzaSy...';
      const keyHelp = this._makeEl('div', { fontSize: '11px', color: 'var(--se-text-muted)', display: 'flex', alignItems: 'center', gap: '4px' });
      const keyHelpText = document.createTextNode('※ APIキーはブラウザにのみ安全に保存されます。');
      const keyHelpLink = document.createElement('a');
      keyHelpLink.href = 'https://aistudio.google.com/app/apikey';
      keyHelpLink.target = '_blank';
      keyHelpLink.rel = 'noopener noreferrer';
      keyHelpLink.style.color = 'var(--se-accent-2)';
      keyHelpLink.textContent = 'Google AI Studio で無料取得 ↗';
      keyHelp.appendChild(keyHelpText);
      keyHelp.appendChild(keyHelpLink);
      keyGroup.appendChild(keyLabel);
      keyGroup.appendChild(keyInput);
      keyGroup.appendChild(keyHelp);

      // モデル選択
      const modelGroup = this._makeEl('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
      const modelHeaderRow = this._makeEl('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
      const modelLabel = this._makeEl('label', { fontSize: '12px', fontWeight: '600', color: 'var(--se-text-primary)' });
      modelLabel.textContent = '使用モデル';
      const btnFetch = this._makeEl('button', {
        background: 'var(--se-bg-tertiary)', border: '1px solid var(--se-border)', borderRadius: '4px',
        color: 'var(--se-text-secondary)', fontSize: '11px', padding: '3px 8px', cursor: 'pointer'
      });
      btnFetch.textContent = '🔄 最新モデル一覧を取得';
      btnFetch.onclick = async () => {
        const k = keyInput.value.trim() || this.gemini.getApiKey();
        if (!k) return this._showToast('APIキーを入力してください', true);
        btnFetch.textContent = '🔄 取得中...';
        try {
          const list = await this.gemini.listModels(k);
          this._populateModelSelect(list, modelSelect.value);
          this._showToast(`モデル一覧を${list.length}件取得しました`);
        } catch(e) {
          this._showToast(e.message, true);
        } finally {
          btnFetch.textContent = '🔄 最新モデル一覧を取得';
        }
      };
      modelHeaderRow.appendChild(modelLabel);
      modelHeaderRow.appendChild(btnFetch);

      this.aiModelSelect = document.createElement('select');
      this.aiModelSelect.className = 'se-select';
      this.aiModelSelect.style.width = '100%';
      const modelSelect = this.aiModelSelect;

      this.aiCustomModelInput = document.createElement('input');
      this.aiCustomModelInput.className = 'se-input';
      this.aiCustomModelInput.style.width = '100%';
      this.aiCustomModelInput.placeholder = 'カスタムモデル名を入力 (例: gemini-2.5-flash)';
      this.aiCustomModelInput.style.display = 'none';

      this._populateModelSelect();

      modelSelect.onchange = () => {
        this.aiCustomModelInput.style.display = modelSelect.value === 'custom' ? 'block' : 'none';
      };

      modelGroup.appendChild(modelHeaderRow);
      modelGroup.appendChild(modelSelect);
      modelGroup.appendChild(this.aiCustomModelInput);

      // 自動適用トグル
      const autoApplyGroup = this._makeEl('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--se-border)', paddingTop: '12px' });
      const autoApplyLabelCol = this._makeEl('div', { display: 'flex', flexDirection: 'column', gap: '2px' });
      const autoApplyTitle = this._makeEl('div', { fontSize: '13px', fontWeight: '600', color: 'var(--se-text-primary)' });
      autoApplyTitle.textContent = '✨ 生成・修正コードの自動適用 (Auto-Apply)';
      const autoApplyDesc = this._makeEl('div', { fontSize: '11px', color: 'var(--se-text-muted)' });
      autoApplyDesc.textContent = 'AIの回答受信時に、ボタンを押さずに自動でエディタ反映・プレビューします。';
      autoApplyLabelCol.appendChild(autoApplyTitle);
      autoApplyLabelCol.appendChild(autoApplyDesc);

      const autoApplySwitch = this._createToggle(this.autoApply, (checked) => {
        this.autoApply = checked;
        localStorage.setItem('se_auto_apply', checked ? 'true' : 'false');
      });
      autoApplyGroup.appendChild(autoApplyLabelCol);
      autoApplyGroup.appendChild(autoApplySwitch);

      // 保存ボタン
      const btnSave = this._createBtn('設定を保存して閉じる', 'var(--se-accent)', () => {
        const key = keyInput.value.trim();
        let m = modelSelect.value;
        if (m === 'custom') m = this.aiCustomModelInput.value.trim() || 'gemini-2.5-flash';
        this.gemini.setApiKey(key);
        this.gemini.setModel(m);
        this._setUIMode(modeSelect.value);
        this._updateModelBadge();
        this._showToast(`設定を保存しました (モデル: ${m})`);
        overlay.remove();
      }, 'save');
      btnSave.style.justifyContent = 'center';
      btnSave.style.padding = '10px';

      modal.appendChild(modalHeader);
      modal.appendChild(modeGroup);
      modal.appendChild(keyGroup);
      modal.appendChild(modelGroup);
      modal.appendChild(autoApplyGroup);
      modal.appendChild(btnSave);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    }

    _showCompileError(vErr, fErr) {
      if (this.fragmentPanel) {
        this.fragmentPanel.errorPanel.textContent = fErr || '';
        this.fragmentPanel.errorPanel.style.maxHeight = fErr ? '80px' : '0';
        this.fragmentPanel.errorPanel.style.padding = fErr ? '8px' : '0';
      }
      if (this.vertexPanel) {
        this.vertexPanel.errorPanel.textContent = vErr || '';
        this.vertexPanel.errorPanel.style.maxHeight = vErr ? '80px' : '0';
        this.vertexPanel.errorPanel.style.padding = vErr ? '8px' : '0';
      }
      this._lastCompilationError = (vErr ? 'Vertex:\n' + vErr + '\n' : '') + (fErr ? 'Fragment:\n' + fErr : '');
      if (this.aiErrorBanner) {
        this.aiErrorBanner.style.display = (vErr || fErr) ? 'flex' : 'none';
      }
    }

    _clearEditorErrors() {
      this._showCompileError(null, null);
    }

    _populateModelSelect(modelsList = null, selectedModel = null) {
      if (!this.aiModelSelect) return;
      const targetModel = selectedModel || this.gemini.getModel();
      
      const defaultModels = [
        { id: 'gemini-2.5-flash', text: 'Gemini 2.5 Flash (最新・超高速推奨)' },
        { id: 'gemini-2.5-pro', text: 'Gemini 2.5 Pro (最新・最高性能)' },
        { id: 'gemini-2.0-flash', text: 'Gemini 2.0 Flash' },
        { id: 'gemini-2.0-flash-lite', text: 'Gemini 2.0 Flash Lite (軽量)' },
        { id: 'gemini-2.0-pro-exp-02-05', text: 'Gemini 2.0 Pro Experimental' },
        { id: 'gemini-1.5-flash', text: 'Gemini 1.5 Flash' },
        { id: 'gemini-1.5-pro', text: 'Gemini 1.5 Pro' }
      ];

      const listToRender = (modelsList && modelsList.length > 0)
        ? modelsList.map(m => {
            let tooltip = m.description || '';
            if (m.inputLimit || m.outputLimit) {
              const inStr = m.inputLimit ? `入力上限: ${Number(m.inputLimit).toLocaleString()} tokens` : '';
              const outStr = m.outputLimit ? `出力上限: ${Number(m.outputLimit).toLocaleString()} tokens` : '';
              const limitStr = [inStr, outStr].filter(Boolean).join(' / ');
              tooltip = tooltip ? `${tooltip}\n(${limitStr})` : limitStr;
            }
            return {
              id: m.id,
              text: m.displayName || m.id,
              title: tooltip
            };
          })
        : defaultModels;

      this.aiModelSelect.replaceChildren();

      let isKnownModel = false;
      listToRender.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.text;
        if (m.title) opt.title = m.title;
        if (m.id === targetModel) {
          opt.selected = true;
          isKnownModel = true;
        }
        this.aiModelSelect.appendChild(opt);
      });

      // カスタム入力オプションを最後に追加
      const customOpt = document.createElement('option');
      customOpt.value = 'custom';
      customOpt.textContent = 'カスタム入力 (モデル名を手動指定)';
      if (!isKnownModel) {
        customOpt.selected = true;
      }
      this.aiModelSelect.appendChild(customOpt);

      if (this.aiCustomModelInput) {
        if (!isKnownModel || targetModel === 'custom') {
          this.aiCustomModelInput.style.display = 'block';
          this.aiCustomModelInput.value = targetModel === 'custom' ? '' : targetModel;
        } else {
          this.aiCustomModelInput.style.display = 'none';
          this.aiCustomModelInput.value = targetModel;
        }
      }
    }

    async _fetchAndPopulateModels(isUserAction = true) {
      const key = (this.aiKeyInput ? this.aiKeyInput.value.trim() : '') || this.gemini.getApiKey();
      if (!key) {
        if (isUserAction) {
          this._showToast('APIキーを入力してください', true);
        }
        return;
      }

      if (this.btnFetchModels) {
        this.btnFetchModels.textContent = '🔄 取得中...';
        this.btnFetchModels.disabled = true;
      }

      try {
        const fetchedModels = await this.gemini.listModels(key);
        if (fetchedModels && fetchedModels.length > 0) {
          const currentModel = this.aiModelSelect.value === 'custom'
            ? (this.aiCustomModelInput ? this.aiCustomModelInput.value.trim() : this.gemini.getModel())
            : this.aiModelSelect.value;
          this._populateModelSelect(fetchedModels, currentModel);
          this._hasFetchedModels = true;
          if (isUserAction) {
            this._showToast(`利用可能なモデルを${fetchedModels.length}件取得しました`);
          }
        } else {
          if (isUserAction) {
            this._showToast('利用可能なモデルが見つかりませんでした', true);
          }
        }
      } catch (err) {
        console.warn('[ShaderEditor] listModels error:', err);
        if (isUserAction) {
          this._showToast(err.message, true);
        }
      } finally {
        if (this.btnFetchModels) {
          this.btnFetchModels.textContent = '🔄 最新モデル一覧を取得';
          this.btnFetchModels.disabled = false;
        }
      }
    }

    _saveAISettings() {
      const key = this.aiKeyInput.value.trim();
      let model = this.aiModelSelect.value;
      if (model === 'custom' || !model) {
        model = (this.aiCustomModelInput && this.aiCustomModelInput.value.trim()) || 'gemini-2.5-flash';
      }
      this.gemini.setApiKey(key);
      this.gemini.setModel(model);
      this._showToast(`Geminiの設定を保存しました (モデル: ${model})`);
    }

    show() { this.container.style.display = 'block'; this._updateList(); if(this.currentShader) this.loadShader(this.currentShader); else this._showEmptyState(); }
    hide() { this.container.style.display = 'none'; }
  }

  class ShaderExtension {
    constructor() {
      this.shaderManager = new ShaderManager();
      this.shaderManager.setupProjectHooks();
      this.editor = new ShaderEditor(this.shaderManager);
    }
    
    static BUILTIN_UNIFORMS = new Set([
      'u_texture', 'u_time', 'u_resolution', 'u_canvasResolution', 'u_pixelRatio',
      'u_isSprite', 'u_spritePos', 'u_spriteSize', 'u_spriteDirection', 'u_spriteBounds'
    ]);

    _getTargetMenu() {
      const menu = [
        { text: 'このスプライト', value: '_myself_' },
        { text: 'Stage', value: 'Stage' }
      ];
      if (Scratch.vm && Scratch.vm.runtime && Scratch.vm.runtime.targets) {
        for (const target of Scratch.vm.runtime.targets) {
          if (!target.isStage) {
            const name = target.getName ? target.getName() : (target.sprite ? target.sprite.name : null);
            if (name && !menu.some(m => m.text === name)) {
              menu.push({ text: name, value: name });
            }
          }
        }
      }
      return menu;
    }

    _getShaderWithNoneMenu() {
      const menu = [{ text: '(なし)', value: '' }];
      const names = Array.from(this.shaderManager.shaders.keys());
      for (const name of names) {
        menu.push({ text: name, value: name });
      }
      return menu;
    }

    _getShaderMenu() {
      const names = Array.from(this.shaderManager.shaders.keys());
      return names.length === 0 ? [{text: '(なし)', value: ''}] : names.map(n => ({text: n, value: n}));
    }

    _getSingleShaderMenu() {
      const names = Array.from(this.shaderManager.shaders.keys()).filter(n => !this.shaderManager.getShader(n)?.isIntegrated);
      return names.length === 0 ? [{text: '(なし)', value: ''}] : names.map(n => ({text: n, value: n}));
    }

    _getIntegratedMenu() {
      const names = Array.from(this.shaderManager.shaders.keys()).filter(n => this.shaderManager.getShader(n)?.isIntegrated);
      return names.length === 0 ? [{text: '(なし)', value: ''}] : names.map(n => ({text: n, value: n}));
    }

    _parseUniforms(source) {
      const results = [];
      const re = /(?:uniform|const)\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+\s+(\w+)\s*(?:\[.*?\])?(?:\s*=\s*[^;]+)?\s*;/g;
      let m;
      while ((m = re.exec(source)) !== null) {
        if (!ShaderExtension.BUILTIN_UNIFORMS.has(m[1]) && !results.includes(m[1])) {
          results.push(m[1]);
        }
      }
      return results;
    }

    _getUniformMenu(type, isIntegrated) {
      const items = [];
      const seen = new Set();
      for (const name of this.shaderManager.shaders.keys()) {
        const s = this.shaderManager.getShader(name);
        if (!s || s.isIntegrated !== isIntegrated) continue;
        const targets = isIntegrated ? s.children : [s];
        for (const target of targets) {
          const sources = type === 'all' ? [target.vertexSource, target.fragmentSource] : (type === 'vertex' ? [target.vertexSource] : [target.fragmentSource]);
          for (const source of sources) {
            for (const uName of this._parseUniforms(source)) {
              const suffix = source === target.vertexSource ? 'V' : 'F';
              const key = `${uName}__${suffix}`;
              if (!seen.has(key)) {
                seen.add(key);
                items.push({ text: `${uName} #${name} ${suffix}`, value: `${uName} #${name} ${suffix}` });
              }
            }
          }
        }
      }
      return items.length === 0 ? [{ text: '(なし)', value: '' }] : items;
    }

    _getSingleUniformMenu() { return this._getUniformMenu('all', false); }
    _getIntegratedUniformMenu() { return this._getUniformMenu('all', true); }
    _getSingleVertexUniformMenu() { return this._getUniformMenu('vertex', false); }
    _getSingleFragmentUniformMenu() { return this._getUniformMenu('fragment', false); }
    _getIntegratedVertexUniformMenu() { return this._getUniformMenu('vertex', true); }
    _getIntegratedFragmentUniformMenu() { return this._getUniformMenu('fragment', true); }

    _stripUniformSuffix(raw) { return String(raw).trim().replace(/\s*#.*$/, ''); }

    _resolveTargetKey(rawTarget, util) {
      if (!rawTarget || rawTarget === '_myself_' || rawTarget === 'このスプライト') {
        if (util && util.target) {
          return util.target.isStage ? 'Stage' : util.target.id;
        }
        return '_myself_';
      }
      return String(rawTarget).trim();
    }

    getInfo() {
      return {
        id: 'glslshader', name: 'GLSL Shader', blockIconURI,
        blocks: [
          { opcode: 'open_glsl_shader_editor', blockType: Scratch.BlockType.BUTTON, text: 'シェーダーを管理する', func: 'open_glsl_shader_editor' },
          { opcode: 'open_glsl_ai_copilot', blockType: Scratch.BlockType.BUTTON, text: '✨ Gemini AI アシスタントを開く', func: 'open_glsl_ai_copilot' },
          '---',
          // スプライト単体シェーダー用ブロック
          { opcode: 'set_sprite_shader', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダーを [SHADER] にする', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderWithNoneMenu' } } },
          { opcode: 'set_sprite_shader_enabled', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダー [SHADER] を [ENABLED] にする', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' }, ENABLED: { type: Scratch.ArgumentType.STRING, menu: 'enabledMenu' } } },
          { opcode: 'clear_sprite_shaders', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダーをすべて解除する', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' } } },
          { opcode: 'set_sprite_uniform', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダー [SHADER] の変数 [UNIFORM] を [VALUE] にする', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleUniformMenu' }, VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1.0 } } },
          { opcode: 'change_sprite_uniform', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダー [SHADER] の変数 [UNIFORM] を [VALUE] ずつ変える', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleUniformMenu' }, VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1.0 } } },
          { opcode: 'get_sprite_uniform', blockType: Scratch.BlockType.REPORTER, text: 'スプライト [TARGET] のシェーダー [SHADER] の変数 [UNIFORM]', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleUniformMenu' } } },
          { opcode: 'is_sprite_shader_active', blockType: Scratch.BlockType.BOOLEAN, text: 'スプライト [TARGET] のシェーダー [SHADER] は有効？', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' } } },
          '---',
          // 全画面シェーダー用ブロック
          { opcode: 'set_shader_enabled', blockType: Scratch.BlockType.COMMAND, text: '単体シェーダー [SHADER] を [ENABLED] にする', arguments: { SHADER: { type: Scratch.ArgumentType.STRING, menu: 'singleShaderMenu' }, ENABLED: { type: Scratch.ArgumentType.STRING, menu: 'enabledMenu' } } },
          { opcode: 'set_single_uniform', blockType: Scratch.BlockType.COMMAND, text: '単体シェーダー [SHADER] の変数 [UNIFORM] を [VALUE] にする', arguments: { SHADER: { type: Scratch.ArgumentType.STRING, menu: 'singleShaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleUniformMenu' }, VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1.0 } } },
          { opcode: 'change_single_uniform', blockType: Scratch.BlockType.COMMAND, text: '単体シェーダー [SHADER] の変数 [UNIFORM] を [VALUE] ずつ変える', arguments: { SHADER: { type: Scratch.ArgumentType.STRING, menu: 'singleShaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleUniformMenu' }, VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1.0 } } },
          { opcode: 'get_single_vertex_uniform', blockType: Scratch.BlockType.REPORTER, text: '単体シェーダー [SHADER] の頂点の変数 [UNIFORM]', arguments: { SHADER: { type: Scratch.ArgumentType.STRING, menu: 'singleShaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleVertexUniformMenu' } } },
          { opcode: 'get_single_fragment_uniform', blockType: Scratch.BlockType.REPORTER, text: '単体シェーダー [SHADER] のフラグメントの変数 [UNIFORM]', arguments: { SHADER: { type: Scratch.ArgumentType.STRING, menu: 'singleShaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleFragmentUniformMenu' } } },
          '---',
          { opcode: 'set_integrated_enabled', blockType: Scratch.BlockType.COMMAND, text: '統合シェーダー [INTEGRATED] を [ENABLED] にする', arguments: { INTEGRATED: { type: Scratch.ArgumentType.STRING, menu: 'integratedMenu' }, ENABLED: { type: Scratch.ArgumentType.STRING, menu: 'enabledMenu' } } },
          { opcode: 'set_integrated_uniform', blockType: Scratch.BlockType.COMMAND, text: '統合シェーダー [INTEGRATED] の変数 [UNIFORM] を [VALUE] にする', arguments: { INTEGRATED: { type: Scratch.ArgumentType.STRING, menu: 'integratedMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'integratedUniformMenu' }, VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1.0 } } },
          { opcode: 'change_integrated_uniform', blockType: Scratch.BlockType.COMMAND, text: '統合シェーダー [INTEGRATED] の変数 [UNIFORM] を [VALUE] ずつ変える', arguments: { INTEGRATED: { type: Scratch.ArgumentType.STRING, menu: 'integratedMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'integratedUniformMenu' }, VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1.0 } } },
          { opcode: 'get_integrated_vertex_uniform', blockType: Scratch.BlockType.REPORTER, text: '統合シェーダー [INTEGRATED] の頂点の変数 [UNIFORM]', arguments: { INTEGRATED: { type: Scratch.ArgumentType.STRING, menu: 'integratedMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'integratedVertexUniformMenu' } } },
          { opcode: 'get_integrated_fragment_uniform', blockType: Scratch.BlockType.REPORTER, text: '統合シェーダー [INTEGRATED] のフラグメントの変数 [UNIFORM]', arguments: { INTEGRATED: { type: Scratch.ArgumentType.STRING, menu: 'integratedMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'integratedFragmentUniformMenu' } } },
          '---',
          { opcode: 'is_shader_active', blockType: Scratch.BlockType.BOOLEAN, text: 'シェーダー [SHADER] は有効？', arguments: { SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' } } },
          { opcode: 'get_active_count', blockType: Scratch.BlockType.REPORTER, text: '有効なシェーダーの数' },
          '---',
          { opcode: 'set_single_shader_default', blockType: Scratch.BlockType.COMMAND, text: '単体シェーダー [SHADER] をデフォルトにする', arguments: { SHADER: { type: Scratch.ArgumentType.STRING, menu: 'singleShaderMenu' } } },
          { opcode: 'set_integrated_shader_default', blockType: Scratch.BlockType.COMMAND, text: '統合シェーダー [INTEGRATED] をデフォルトにする', arguments: { INTEGRATED: { type: Scratch.ArgumentType.STRING, menu: 'integratedMenu' } } },
          '---',
          // Gemini AI 連携ブロック
          { opcode: 'generate_shader_with_gemini', blockType: Scratch.BlockType.COMMAND, text: '[PROMPT] からシェーダー [NAME] をGeminiで生成する', arguments: { PROMPT: { type: Scratch.ArgumentType.STRING, defaultValue: '水面の波紋エフェクト' }, NAME: { type: Scratch.ArgumentType.STRING, defaultValue: '波紋AI' } } },
          { opcode: 'set_gemini_api_key', blockType: Scratch.BlockType.COMMAND, text: 'GeminiのAPIキーを [KEY] に設定する', arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: '' } } }
        ],
        menus: {
          targetMenu: { acceptReporters: true, items: '_getTargetMenu' },
          shaderWithNoneMenu: { acceptReporters: true, items: '_getShaderWithNoneMenu' },
          shaderMenu: { acceptReporters: true, items: '_getShaderMenu' },
          singleShaderMenu: { acceptReporters: true, items: '_getSingleShaderMenu' },
          integratedMenu: { acceptReporters: true, items: '_getIntegratedMenu' },
          singleUniformMenu: { acceptReporters: true, items: '_getSingleUniformMenu' },
          integratedUniformMenu: { acceptReporters: true, items: '_getIntegratedUniformMenu' },
          singleVertexUniformMenu: { acceptReporters: true, items: '_getSingleVertexUniformMenu' },
          singleFragmentUniformMenu: { acceptReporters: true, items: '_getSingleFragmentUniformMenu' },
          integratedVertexUniformMenu: { acceptReporters: true, items: '_getIntegratedVertexUniformMenu' },
          integratedFragmentUniformMenu: { acceptReporters: true, items: '_getIntegratedFragmentUniformMenu' },
          enabledMenu: { acceptReporters: true, items: ['true', 'false'] }
        }
      };
    }
    
    open_glsl_shader_editor() { this.editor.show(); }
    open_glsl_ai_copilot() {
      this.editor.show();
      this.editor.isAIPanelOpen = true;
      if (this.editor.uiMode === 'chat') {
        this.editor._setUIMode('chat');
      } else {
        this.editor.aiPanel.style.display = 'flex';
      }
    }
    openEditor() { this.open_glsl_shader_editor(); }
    openAIPanel() { this.open_glsl_ai_copilot(); }

    set_gemini_api_key(args) {
      if (this.editor && this.editor.gemini) {
        this.editor.gemini.setApiKey(args.KEY);
      }
    }

    generate_shader_with_gemini(args) {
      return new Promise(async (resolve) => {
        try {
          if (!this.editor || !this.editor.gemini) {
            console.warn('[ShaderExtension] GeminiService not initialized');
            return resolve();
          }
          const prompt = String(args.PROMPT || '').trim();
          if (!prompt) return resolve();

          const result = await this.editor.gemini.generateShader(prompt);
          const name = String(args.NAME || result.name || 'AIシェーダー').trim();
          
          this.shaderManager.addShader(
            name,
            result.vertexShader || '',
            result.fragmentShader || '',
            result.jsCode || ''
          );
          this.shaderManager.saveShadersToProject();
          this.shaderManager.isDirty = true;
          if (this.editor) this.editor._updateList();
        } catch (err) {
          console.warn('[ShaderExtension] generate_shader_with_gemini error:', err);
        }
        resolve();
      });
    }

    // スプライト用ハンドラ
    set_sprite_shader(args, util) {
      const key = this._resolveTargetKey(args.TARGET, util);
      this.shaderManager.setTargetShader(key, args.SHADER);
    }

    set_sprite_shader_enabled(args, util) {
      const key = this._resolveTargetKey(args.TARGET, util);
      this.shaderManager.setTargetShaderEnabled(key, args.SHADER, args.ENABLED === 'true');
    }

    clear_sprite_shaders(args, util) {
      const key = this._resolveTargetKey(args.TARGET, util);
      this.shaderManager.clearTargetShaders(key);
    }

    set_sprite_uniform(args, util) {
      const key = this._resolveTargetKey(args.TARGET, util);
      const u = this._stripUniformSuffix(args.UNIFORM);
      this.shaderManager.setTargetUniform(key, args.SHADER, u, args.VALUE);
    }

    change_sprite_uniform(args, util) {
      const key = this._resolveTargetKey(args.TARGET, util);
      const u = this._stripUniformSuffix(args.UNIFORM);
      const current = Number(this.shaderManager.getTargetUniform(key, args.SHADER, u)) || 0;
      this.shaderManager.setTargetUniform(key, args.SHADER, u, current + (Number(args.VALUE) || 0));
    }

    get_sprite_uniform(args, util) {
      const key = this._resolveTargetKey(args.TARGET, util);
      const u = this._stripUniformSuffix(args.UNIFORM);
      const val = this.shaderManager.getTargetUniform(key, args.SHADER, u);
      return val !== undefined ? String(val) : '';
    }

    is_sprite_shader_active(args, util) {
      const key = this._resolveTargetKey(args.TARGET, util);
      return this.shaderManager.isTargetShaderActive(key, args.SHADER);
    }

    // 全画面用ハンドラ
    set_shader_enabled(args) { this.shaderManager.setEnabled(args.SHADER, args.ENABLED === 'true'); }
    set_single_uniform(args) { this.shaderManager.setUniform(args.SHADER, this._stripUniformSuffix(args.UNIFORM), args.VALUE); }
    change_single_uniform(args) {
      const u = this._stripUniformSuffix(args.UNIFORM);
      const s = this.shaderManager.getShader(args.SHADER);
      if (s) this.shaderManager.setUniform(args.SHADER, u, (Number(s.uniformValues[u]) || 0) + Number(args.VALUE) || 0);
    }
    get_single_vertex_uniform(args) {
      const s = this.shaderManager.getShader(args.SHADER);
      if (!s || s.isIntegrated) return '';
      const v = s.uniformValues[this._stripUniformSuffix(args.UNIFORM)];
      return v !== undefined ? String(v) : '';
    }
    get_single_fragment_uniform(args) {
      const s = this.shaderManager.getShader(args.SHADER);
      if (!s || s.isIntegrated) return '';
      const v = s.uniformValues[this._stripUniformSuffix(args.UNIFORM)];
      return v !== undefined ? String(v) : '';
    }
    set_integrated_enabled(args) {
      const s = this.shaderManager.getShader(args.INTEGRATED);
      if (s && s.isIntegrated) { this.shaderManager.setEnabled(args.INTEGRATED, args.ENABLED === 'true'); this.shaderManager.isDirty = true; }
    }
    set_integrated_uniform(args) {
      const s = this.shaderManager.getShader(args.INTEGRATED);
      if (s && s.isIntegrated) { s.uniformValues[this._stripUniformSuffix(args.UNIFORM)] = args.VALUE; this.shaderManager.isDirty = true; }
    }
    change_integrated_uniform(args) {
      const s = this.shaderManager.getShader(args.INTEGRATED);
      if (s && s.isIntegrated) { const u = this._stripUniformSuffix(args.UNIFORM); s.uniformValues[u] = (Number(s.uniformValues[u])||0) + (Number(args.VALUE)||0); this.shaderManager.isDirty = true; }
    }
    get_integrated_vertex_uniform(args) {
      const s = this.shaderManager.getShader(args.INTEGRATED);
      if (!s || !s.isIntegrated) return '';
      const v = s.uniformValues[this._stripUniformSuffix(args.UNIFORM)];
      return v !== undefined ? String(v) : '';
    }
    get_integrated_fragment_uniform(args) {
      const s = this.shaderManager.getShader(args.INTEGRATED);
      if (!s || !s.isIntegrated) return '';
      const v = s.uniformValues[this._stripUniformSuffix(args.UNIFORM)];
      return v !== undefined ? String(v) : '';
    }
    is_shader_active(args) { return this.shaderManager.activeShaders.includes(args.SHADER); }
    get_active_count() { return this.shaderManager.activeShaders.length; }

    _clearShaderUniformOverrides(shader) {
      if (!shader) return;
      const reset = (s) => {
        s.uniformValues = {};
        if (s.uniforms) {
          for (const [name, info] of Object.entries(s.uniforms)) {
            if (!ShaderExtension.BUILTIN_UNIFORMS.has(name)) s.uniformValues[name] = "0";
          }
        }
      };
      if (shader.isIntegrated && shader.children) shader.children.forEach(reset);
      else reset(shader);
    }

    set_single_shader_default(args) {
      const s = this.shaderManager.getShader(args.SHADER);
      if (s && !s.isIntegrated) { this._clearShaderUniformOverrides(s); this.shaderManager.isDirty = true; this.shaderManager.saveShadersToProject(); }
    }
    set_integrated_shader_default(args) {
      const s = this.shaderManager.getShader(args.INTEGRATED);
      if (s && s.isIntegrated) { this._clearShaderUniformOverrides(s); this.shaderManager.isDirty = true; this.shaderManager.saveShadersToProject(); }
    }
  }

  Scratch.extensions.register(new ShaderExtension());
})(Scratch);
