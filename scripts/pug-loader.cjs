// Minimal pug 3 webpack loader. The pug-loader@1.0.2 currently in the tree is the
// deprecated non-webpack pug-load package (npm marks it "Please use pug-load"),
// and pug-loader@2.4.0 declares peer pug@^2 which conflicts with pug 3.
const pug = require('pug')

module.exports = function (source) {
    if (this.cacheable) {
        this.cacheable()
    }
    const template = pug.compileClient(source, { filename: this.resourcePath })
    return `${template}\nmodule.exports = template;`
}
