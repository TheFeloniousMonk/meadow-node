# Reproducible build of the meadow-crypto WebAssembly binding. Nothing here
# needs Rust on the host:
#   docker build --output type=local,dest=pkg crypto
# writes pkg/ (meadow_crypto.js, meadow_crypto_bg.wasm, and their .d.ts) next
# to this file. Versions are pinned: Rust here, vodozemac and wasm-bindgen in
# Cargo.toml and Cargo.lock. The wasm-bindgen CLI must equal the crate version.
FROM rust:1.98.1-slim-bookworm AS build
ARG WASM_BINDGEN=0.2.129
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version "=${WASM_BINDGEN}" --locked
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY .cargo .cargo
COPY src src
# Uses Cargo.lock when present (commit it after the first build); the build
# copies the lock it used into pkg/ so it can be committed.
RUN cargo build --release --target wasm32-unknown-unknown
RUN wasm-bindgen --target nodejs --out-dir /pkg target/wasm32-unknown-unknown/release/meadow_crypto.wasm \
 && cp Cargo.lock /pkg/Cargo.lock
# The generated glue is CommonJS, and the repository's package.json says ESM.
RUN echo '{ "type": "commonjs" }' > /pkg/package.json

FROM scratch
COPY --from=build /pkg /
