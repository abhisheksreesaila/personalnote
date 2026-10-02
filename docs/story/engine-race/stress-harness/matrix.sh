cd "$(dirname "$0")"
S=dragConnected,dragAcrossEdge,pan,zoom,zoomMaxProbe,deleteCollapse
node run.mjs '[{"mode":"full","caching":1,"skip":1,"dpr":1},{"mode":"full","caching":0,"skip":1,"dpr":1},{"mode":"viewport","caching":1,"skip":1,"dpr":1},{"mode":"viewport","caching":1,"skip":0,"dpr":1},{"mode":"viewport","caching":0,"skip":1,"dpr":1},{"mode":"full","caching":1,"skip":1,"dpr":2},{"mode":"full","caching":0,"skip":1,"dpr":2},{"mode":"viewport","caching":1,"skip":1,"dpr":2}]' $S
node run.mjs '[{"mode":"full","caching":1,"skip":1,"dpr":1,"rar":1},{"mode":"viewport","caching":1,"skip":1,"dpr":1,"rar":1}]' deleteCollapse
