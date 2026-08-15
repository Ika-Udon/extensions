(function (Scratch) {
  "use strict";

  class NetworkFetchExtension {
    getInfo() {
      return {
        id: "networkfetch",
        name: "ネットワーク通信",
        color1: "#3b82f6",
        color2: "#2563eb",
        blocks: [
          {
            opcode: "fetch_text",
            blockType: Scratch.BlockType.REPORTER,
            text: "URL [URL] からテキストを取得",
            arguments: {
              URL: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "https://api.github.com"
              }
            }
          }
        ]
      };
    }

    async fetch_text(args) {
      try {
        const response = await fetch(args.URL);
        if (!response.ok) {
          return "";
        }
        return await response.text();
      } catch (error) {
        console.warn("Fetch error:", error);
        return "";
      }
    }
  }

  Scratch.extensions.register(new NetworkFetchExtension());
})(Scratch);
