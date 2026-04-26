/** Code JS du parseur Raw, évalué dans le Web Worker */
export const RAW_PARSER_CODE = `({
  name: "Raw",
  version: "1.0.0",
  description: "Affiche les données brutes sans décodage",
  decode(hex) {
    const byteCount = Math.floor(hex.length / 2);
    return {
      fields: [{
        name: "Data",
        value: hex.match(/.{1,2}/g)?.join(" ") || hex,
        bytes: [0, byteCount],
        color: "gray"
      }],
      summary: byteCount + " octet" + (byteCount > 1 ? "s" : "")
    };
  }
})`;
