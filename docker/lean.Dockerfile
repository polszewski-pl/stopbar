# Lean 4.34.0 for `npm run verify:lean` (Stopbar PROVE, release gate only). No elan, no Mathlib, nothing installed on
# the host. The network is needed only to build this image; the proof itself runs with `docker run --network none`.
#
# Build (once, needs the network):
#   docker build -f docker/lean.Dockerfile -t stopbar-lean:4.34.0 docker
#
# Pinning: the base image by digest, the Lean archive by sha256 (both recorded at the first build on 2026-11-26), and the
# Lean version checked after the install. Any change makes the build fail.
ARG BASE=debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e
FROM ${BASE}

ARG LEAN_VERSION=4.34.0
ARG LEAN_SHA256=caaa98356098c85dc0fcbbd28e1ec66f39eb6551829972b752ff20e1286b646b

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl zstd \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    url="https://github.com/leanprover/lean4/releases/download/v${LEAN_VERSION}/lean-${LEAN_VERSION}-linux.tar.zst"; \
    curl -fsSL --retry 3 -o /tmp/lean.tar.zst "$url"; \
    sum="$(sha256sum /tmp/lean.tar.zst | cut -d' ' -f1)"; \
    echo "lean archive sha256 ${sum}" | tee /lean-archive.sha256; \
    if [ -n "${LEAN_SHA256}" ] && [ "${sum}" != "${LEAN_SHA256}" ]; then echo "sha256 mismatch: want ${LEAN_SHA256}" >&2; exit 1; fi; \
    mkdir -p /opt/lean; \
    tar --zstd -xf /tmp/lean.tar.zst -C /opt/lean --strip-components=1; \
    rm /tmp/lean.tar.zst

ENV PATH=/opt/lean/bin:${PATH}
RUN lean --version | grep -F "version ${LEAN_VERSION}" && lake --version

# an unprivileged user runs the proof; the project is mounted read-only at /src and built in a copy
RUN useradd -m -u 1000 prover
USER prover
WORKDIR /home/prover
CMD ["sh", "-c", "cp -r /src /home/prover/p && cd /home/prover/p && lake build"]
