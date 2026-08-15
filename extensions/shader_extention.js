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
      this.targetShaders = new Map();
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
      const idState = this.targetShaders.get(target.id);
      if (idState && idState.activeShaders && idState.activeShaders.length > 0) {
        return idState.activeShaders;
      }
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
          this.gl.bindTexture(this.gl.TEXTURE_2D, this.sourceTexture.texture);
          this.gl.copyTexSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, 0, 0, canvas.width, canvas.height);
          this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.sourceTexture.framebuffer);
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

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.spriteSourceFBO.framebuffer);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      this.originalDrawFunction([drawableID], drawMode, projection, opts);

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

      if (this.hasAnySpriteShaders() && this.renderer) {
        this.renderer.draw();
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

  const SafeStorage = {
    _memory: new Map(),
    getItem(key) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          return window.localStorage.getItem(key);
        }
      } catch (e) {
        // サンドボックス等でアクセス制限された場合はフォールバック
      }
      return this._memory.has(key) ? this._memory.get(key) : null;
    },
    setItem(key, value) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(key, value);
          return;
        }
      } catch (e) {
        // サンドボックス等でアクセス制限された場合はフォールバック
      }
      this._memory.set(key, String(value));
    },
    removeItem(key) {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.removeItem(key);
          return;
        }
      } catch (e) {
        // サンドボックス等でアクセス制限された場合はフォールバック
      }
      this._memory.delete(key);
    }
  };

  class GeminiService {
    constructor() {
      this.apiKey = SafeStorage.getItem('se_gemini_api_key') || '';
      this.model = SafeStorage.getItem('se_gemini_model') || 'gemini-2.5-flash';
    }

    setApiKey(key) {
      this.apiKey = (key || '').trim();
      SafeStorage.setItem('se_gemini_api_key', this.apiKey);
    }

    getApiKey() {
      return this.apiKey;
    }

    setModel(model) {
      this.model = model;
      SafeStorage.setItem('se_gemini_model', this.model);
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

【コード提示時の重要ルール】
- シェーダーを新しく作成または修正する場合、回答の冒頭（1行目）に必ず「### シェーダー名: [シンプルで分かりやすい日本語名]」または「### 統合シェーダー名: [名前]」を明記してください。
- シェーダーコードを作成・修正する場合は、必ず完全なコードをMarkdownのコードブロックで提供してください。
- Fragment Shaderのコードブロックには \`\`\`glsl または \`\`\`frag と明記してください。
- Vertex Shaderのコードブロックには \`\`\`vert と明記してください。
- JavaScriptコード（アニメーションやUniform制御用）がある場合は \`\`\`javascript で記述してください。
- コードブロックの前後に、エフェクトの仕組みや修正点、使い方を日本語で親切かつ分かりやすく解説してください。
`.trim();

      let contextMsg = '';
      if (currentData) {
        if (currentData.isIntegrated) {
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
          contextMsg = `\n\n【現在編集中: 統合シェーダー「${currentData.parentName}」の子シェーダー「${currentData.name}」】\n` +
            `[Fragment Shader]\n\`\`\`glsl\n${currentData.fragmentSource || ''}\n\`\`\`\n` +
            `[Vertex Shader]\n\`\`\`glsl\n${currentData.vertexSource || ''}\n\`\`\`\n` +
            `[JavaScript]\n\`\`\`javascript\n${currentData.jsSource || ''}\n\`\`\``;
        } else if (currentData.fragmentSource || currentData.vertexSource) {
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
- 【最重要】調整用パラメータは \`const float\` または \`uniform float\` で定義すること。

【出力フォーマット】
以下のJSONフォーマットのみを返してください（必ず \`\`\`json ... \`\`\` で囲んでください）:
\`\`\`json
{
  "name": "シェーダー名（日本語推奨）",
  "description": "シェーダーの特徴やエフェクトの解説",
  "vertexShader": "attribute vec2 a_position;\\nattribute vec2 a_texCoord;\\nvarying vec2 v_texCoord;\\n\\nvoid main() {\\n  gl_Position = vec4(a_position, 0.0, 1.0);\\n  v_texCoord = a_texCoord;\\n}",
  "fragmentShader": "precision mediump float;\\nuniform sampler2D u_texture;\\nuniform float u_time;\\nvarying vec2 v_texCoord;\\n\\nconst float SPEED = 1.0;\\n\\nvoid main() {\\n  gl_FragColor = texture2D(u_texture, v_texCoord);\\n}",
  "jsCode": "// 初期化時に1回呼ばれる\\nfunction onInit(api) {\\n  \\n}\\n\\n// 毎フレーム呼ばれる\\nfunction onFrame(api) {\\n  \\n}"
}
\`\`\`
`.trim();

      const responseText = await this.generateContent(`【リクエスト】\n${userPrompt}`, systemPrompt);
      return this._parseJsonResponse(responseText);
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
      this.uiMode = SafeStorage.getItem('se_ui_mode') || 'ide';
      this.isSideEditorOpenInChatMode = false;
      this.isAIPanelOpen = true;
      this.autoApply = SafeStorage.getItem('se_auto_apply') !== 'false';
      this.isContextIgnored = false;
      this.chatMessages = [];
      this._hasFetchedModels = false;
      this.container = null;
      if (typeof document !== 'undefined' && document.body) {
        this._buildUI();
      }
    }

    _buildUI() {
      if (this.container || typeof document === 'undefined' || !document.body) return;
      this.container = document.createElement('div');
      this.container.id = 'glsl-shader-studio-overlay-root';
      this.container.className = 'se-container';
      Object.assign(this.container.style, {
        display: 'none', position: 'fixed', inset: '0',
        width: '100vw', height: '100vh',
        background: '#0a0b12',
        zIndex: '100005'
      });

      const win = document.createElement('div');
      win.className = 'se-window';
      Object.assign(win.style, {
        position: 'absolute', inset: '0',
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: '#0a0b12'
      });

      const header = document.createElement('div');
      Object.assign(header.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 24px', background: '#12141f',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: '0', height: '52px', boxSizing: 'border-box'
      });
      
      const titleGroup = document.createElement('div');
      Object.assign(titleGroup.style, { display: 'flex', alignItems: 'center', gap: '14px' });

      const logoText = document.createElement('div');
      Object.assign(logoText.style, { fontSize: '17px', fontWeight: '800', color: '#7c6cf0' });
      logoText.textContent = 'Shader+';
      titleGroup.appendChild(logoText);

      const btnClose = document.createElement('button');
      btnClose.textContent = '閉じる';
      Object.assign(btnClose.style, {
        padding: '6px 14px', background: '#191c2b', color: '#fff', border: 'none',
        borderRadius: '6px', cursor: 'pointer'
      });
      btnClose.onclick = () => this.hide();

      header.appendChild(titleGroup);
      header.appendChild(btnClose);

      const bodyMsg = document.createElement('div');
      Object.assign(bodyMsg.style, {
        flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#8c93a8', fontSize: '16px'
      });
      bodyMsg.textContent = 'Shader+ エディタ (TurboWarp 統合)';

      win.appendChild(header);
      win.appendChild(bodyMsg);
      this.container.appendChild(win);
      document.body.appendChild(this.container);
    }

    loadShader(name) {}
    show() {
      if (!this.container) this._buildUI();
      if (this.container) this.container.style.display = 'block';
    }
    hide() {
      if (this.container) this.container.style.display = 'none';
    }
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
        id: 'glslshader', name: 'Shader+', blockIconURI,
        blocks: [
          { opcode: 'open_glsl_shader_editor', blockType: Scratch.BlockType.BUTTON, text: 'シェーダーを管理する', func: 'open_glsl_shader_editor' },
          { opcode: 'open_glsl_ai_copilot', blockType: Scratch.BlockType.BUTTON, text: '✨ Gemini AI アシスタントを開く', func: 'open_glsl_ai_copilot' },
          '---',
          { opcode: 'set_sprite_shader', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダーを [SHADER] にする', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderWithNoneMenu' } } },
          { opcode: 'set_sprite_shader_enabled', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダー [SHADER] を [ENABLED] にする', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' }, ENABLED: { type: Scratch.ArgumentType.STRING, menu: 'enabledMenu' } } },
          { opcode: 'clear_sprite_shaders', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダーをすべて解除する', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' } } },
          { opcode: 'set_sprite_uniform', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダー [SHADER] の変数 [UNIFORM] を [VALUE] にする', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleUniformMenu' }, VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1.0 } } },
          { opcode: 'change_sprite_uniform', blockType: Scratch.BlockType.COMMAND, text: 'スプライト [TARGET] のシェーダー [SHADER] の変数 [UNIFORM] を [VALUE] ずつ変える', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleUniformMenu' }, VALUE: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1.0 } } },
          { opcode: 'get_sprite_uniform', blockType: Scratch.BlockType.REPORTER, text: 'スプライト [TARGET] のシェーダー [SHADER] の変数 [UNIFORM]', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' }, UNIFORM: { type: Scratch.ArgumentType.STRING, menu: 'singleUniformMenu' } } },
          { opcode: 'is_sprite_shader_active', blockType: Scratch.BlockType.BOOLEAN, text: 'スプライト [TARGET] のシェーダー [SHADER] は有効？', arguments: { TARGET: { type: Scratch.ArgumentType.STRING, menu: 'targetMenu' }, SHADER: { type: Scratch.ArgumentType.STRING, menu: 'shaderMenu' } } },
          '---',
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
    open_glsl_ai_copilot() { this.editor.show(); }

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
  }

  Scratch.extensions.register(new ShaderExtension());
})(Scratch);
