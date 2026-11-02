FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright

# Install Playwright dependencies
RUN node node_modules/playwright/cli.js install chromium --with-deps
RUN pnpm exec patchright install chromium
RUN node node_modules/rebrowser-playwright/cli.js install chromium

# Headful Chromium under a private virtual display avoids headless-only signals.
# install --with-deps above supplies Xvfb; xvfb-run also needs xauth.
RUN apt-get update && apt-get install -y --no-install-recommends xauth \
  && rm -rf /var/lib/apt/lists/*
ENV BROWSER_ENGINE=rebrowser
ENV BROWSER_HEADLESS=false

RUN pnpm run build

RUN chown -R node:node /usr/src/app \
  && chmod -R a+rX /usr/local/share/playwright

ARG PORT
ENV PORT=${PORT}

EXPOSE ${PORT}

USER node

CMD [ "sh", "docker-entrypoint.sh" ]
