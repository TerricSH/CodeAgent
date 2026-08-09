FROM node:22-bookworm-slim

RUN groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/sh sandbox \
    && mkdir -p /workspace \
    && chown -R 10001:10001 /workspace

COPY --chown=10001:10001 workspace-file-tool.js /opt/codeagent/workspace-file-tool.js

USER 10001:10001
WORKDIR /workspace

CMD ["node", "--version"]
