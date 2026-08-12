const path = require('node:path')

module.exports = {
    target: 'electron-renderer',
    entry: './src/index.ts',
    output: { path: path.resolve(__dirname, 'dist'), filename: 'index.js', libraryTarget: 'commonjs2' },
    resolve: { extensions: ['.ts', '.js'] },
    externals: [/^(?:@angular\/|rxjs(?:\/|$)|tabby-(?:core|terminal|settings)$)/],
    module: {
        rules: [
            { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
            { test: /\.pug$/, use: 'pug-loader' },
            { test: /\.s[ac]ss$/, use: ['style-loader', 'css-loader', 'sass-loader'] },
        ],
    },
}
