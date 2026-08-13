function streamToBuffer(readStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readStream.on("data", (chunk) => chunks.push(chunk));
    readStream.on("error", reject);
    readStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

module.exports = { streamToBuffer };
