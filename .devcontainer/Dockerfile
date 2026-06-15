FROM mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm

USER root

RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        jq \
        python3 \
        python3-pip \
        python3-venv \
        zip \
        unzip \
    && rm -rf /var/lib/apt/lists/*

