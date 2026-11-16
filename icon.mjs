const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">',
  '<rect width="128" height="128" rx="28" fill="#1f2937"/>',
  '<text x="64" y="86" font-size="64" font-family="system-ui,sans-serif" font-weight="700" fill="#34d399" text-anchor="middle">Z</text>',
  "</svg>",
].join("")
console.log(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)