# syntax=docker/dockerfile:1.3-labs

FROM rust:latest as build
WORKDIR /app
RUN apt update && apt install -y ocl-icd-opencl-dev
RUN cargo new --bin /app/createXcrunch
COPY Cargo.toml Cargo.lock /app/createXcrunch/
WORKDIR /app/createXcrunch
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/app/createXcrunch/target RUST_LOG=debug cargo build --release

COPY src  src
COPY tests tests

RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/app/createXcrunch/target <<EOF
  set -e
  # update timestamps to force a new build
  touch /app/createXcrunch/src/main.rs
  cargo build --release
  cp target/release/createxcrunch .

EOF

FROM ubuntu:jammy-20231004

ARG DEBIAN_FRONTEND=noninteractive

COPY config-virt /usr/src/config-virt

RUN apt-get update && apt-get install -y \
	wget \
	kmod \
	xz-utils \
	pkg-config \
	&& rm -rf /var/lib/apt/lists/*

RUN cd /usr/src \
	&& cd /usr/src \
	&& wget https://download.nvidia.com/XFree86/Linux-x86_64/535.183.01/NVIDIA-Linux-x86_64-535.183.01-no-compat32.run \
	&& chmod +x NVIDIA-Linux-x86_64-535.183.01-no-compat32.run \
	&& ./NVIDIA-Linux-x86_64-535.183.01-no-compat32.run -s --no-kernel-modules \
	&& rm -rf /usr/src/*
COPY --from=build /app/createXcrunch/createxcrunch /createXcrunch