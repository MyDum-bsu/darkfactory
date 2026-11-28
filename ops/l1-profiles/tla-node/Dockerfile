FROM node:22.23.2-bookworm-slim
LABEL df.l1.profile="tla-node"
ENV TLA_TOOLS_JAR=/opt/tlc/tla2tools.jar
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless ca-certificates curl \
 && mkdir -p /opt/tlc \
 && curl --fail --location --silent --show-error https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar -o "$TLA_TOOLS_JAR" \
 && echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  $TLA_TOOLS_JAR" | sha256sum -c - \
 && rm -rf /var/lib/apt/lists/*

# Automatic safety checks for ANY product using this image. Root modules have
# a same-name .cfg; other .tla files can be imported helper modules. Fail if
# specs exist but no model is configured. Never run candidate check scripts.
RUN <<'INSTALL'
set -eu
cat > /usr/local/bin/l1-tlc <<'SH'
#!/bin/sh
set -eu
export LC_ALL=C
(
  for dir in /candidate/specs /candidate/specs/tla; do
    if [ -L "$dir" ]; then echo "symlink spec directory: $dir" >&2; exit 1; fi
  done
  cd /candidate
  if [ ! -d specs/tla ]; then exit 0; fi
  cd specs/tla
  found=0; checked=0
  meta=$(mktemp -d /tmp/l1-tlc.XXXXXXXX)
  trap 'rm -rf "$meta"' EXIT
  for spec in ./*.tla; do
    if [ -L "$spec" ]; then echo "symlink model: $spec" >&2; exit 1; fi
    [ -e "$spec" ] || continue
    [ -f "$spec" ] || exit 1
    found=1; cfg=${spec%.tla}.cfg
    if [ -L "$cfg" ]; then echo "symlink config: $cfg" >&2; exit 1; fi
    [ -f "$cfg" ] || continue
    checked=$((checked + 1))
    java -XX:+UseParallelGC -Xmx512m -jar "$TLA_TOOLS_JAR" -workers 1 \
      -metadir "$meta/$checked" -config "$cfg" "$spec"
  done
  if [ "$found:$checked" = 1:0 ]; then echo 'no same-name TLC configuration' >&2; exit 1; fi
)
exec "$@"
SH
chmod 0755 /usr/local/bin/l1-tlc
INSTALL

# offlineDockerRunner enforces --network=none --read-only --user=65534:65534,
# a readonly /candidate and writable /tmp tmpfs; these are run, not build flags.
USER 65534:65534
WORKDIR /candidate
ENTRYPOINT ["/usr/local/bin/l1-tlc"]
CMD ["node"]
