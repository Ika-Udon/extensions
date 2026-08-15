(function (Scratch) {
  "use strict";

  class SampleExtension {
    getInfo() {
      return {
        id: "sampleextension",
        name: "サンプル",
        blocks: [
          {
            opcode: "hello",
            blockType: Scratch.BlockType.REPORTER,
            text: "あいさつ"
          }
        ]
      };
    }

    hello() {
      return "こんにちは";
    }
  }

  Scratch.extensions.register(new SampleExtension());
})(Scratch);
