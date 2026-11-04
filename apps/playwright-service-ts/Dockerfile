FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
ARG INSTALL_WEBKIT=false

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright

# Install Playwright dependencies
RUN node node_modules/playwright/cli.js install chromium --with-deps
RUN pnpm exec patchright install chromium
RUN node node_modules/rebrowser-playwright/cli.js install chromium
RUN if [ "$INSTALL_WEBKIT" = "true" ]; then \
      node node_modules/playwright/cli.js install webkit --with-deps \
      && apt-get update && apt-get install -y --no-install-recommends ca-certificates iptables \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# Headful Chromium under a private virtual display avoids headless-only signals.
# install --with-deps above supplies Xvfb; xvfb-run also needs xauth.
RUN apt-get update && apt-get install -y --no-install-recommends xauth \
  && rm -rf /var/lib/apt/lists/*
ENV BROWSER_ENGINE=rebrowser
ENV BROWSER_HEADLESS=false

RUN pnpm run build

# The Firefox binary and identity model are provisioned only for owners that
# opt in; ordinary Chromium images keep their existing browser installation.
ARG INSTALL_CAMOUFOX=false
ENV XDG_CACHE_HOME=/usr/local/share/browser-cache
RUN if [ "$INSTALL_CAMOUFOX" = "true" ]; then \
      node node_modules/playwright-core/cli.js install-deps firefox; \
    fi

RUN if [ "$INSTALL_WEBKIT" = "true" ]; then \
      chown -R root:root /usr/src/app; \
    else chown -R node:node /usr/src/app; fi \
  && chmod 755 /usr/src/app/scripts/webkit-launcher.sh \
  && chmod -R a+rX /usr/local/share/playwright
RUN mkdir -p /usr/local/share/browser-cache \
  && chown -R node:node /usr/local/share/browser-cache

ARG PORT
ENV PORT=${PORT}

EXPOSE ${PORT}

USER node

# Download as the runtime user: recursively chowning the extracted Firefox/font
# bundle in a later layer would duplicate several GB in every optional image.
RUN if [ "$INSTALL_CAMOUFOX" = "true" ]; then \
      node dist/scripts/prepare-camoufox.js; \
    fi

CMD [ "sh", "docker-entrypoint.sh" ]
