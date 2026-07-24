FROM node:20-slim

LABEL org.opencontainers.image.source="https://github.com/deputynl/claudeweb"
LABEL org.opencontainers.image.description="A small self-hosted web UI for Claude Code"
LABEL org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates tmux openssh-client nano \
    && curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && curl -fsSL https://claude.ai/install.sh | bash \
    && rm -rf /var/lib/apt/lists/*

# The native installer puts the binary in ~/.local/bin, which is what your
# host's ~/.claude.json expects if you installed Claude Code the same way
# there. This must be set explicitly since Docker RUN/CMD don't source
# .bashrc, where the installer normally appends this.
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public
COPY tmux.conf /etc/tmux.conf

ENV WORKSPACE_DIR=/workspace
ENV PORT=8080
ENV TTYD_PORT_BASE=7700

EXPOSE 8080
CMD ["node", "server/index.js"]