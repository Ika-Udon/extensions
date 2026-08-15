(function (Scratch) {
  "use strict";

  class CanvasDrawExtension {
    getInfo() {
      return {
        id: "canvasdraw",
        name: "キャンバス描画",
        color1: "#1bd96a",
        color2: "#17be5d",
        blocks: [
          {
            opcode: "draw_circle",
            blockType: Scratch.BlockType.COMMAND,
            text: "キャンバスの x: [X] y: [Y] に半径 [R] 色 [COLOR] の円を描く",
            arguments: {
              X: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 0
              },
              Y: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 0
              },
              R: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 20
              },
              COLOR: {
                type: Scratch.ArgumentType.COLOR,
                defaultValue: "#1bd96a"
              }
            }
          },
          {
            opcode: "clear_canvas",
            blockType: Scratch.BlockType.COMMAND,
            text: "キャンバスをクリア"
          }
        ]
      };
    }

    draw_circle(args) {
      console.log(`Draw circle at (${args.X}, ${args.Y}) radius ${args.R}`);
    }

    clear_canvas() {
      console.log("Canvas cleared");
    }
  }

  Scratch.extensions.register(new CanvasDrawExtension());
})(Scratch);
