FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
COPY fq.deb /tmp/fq.deb
RUN apt-get update && apt-get install -y --no-install-recommends /tmp/fq.deb xvfb webkit2gtk-driver python3 curl ca-certificates fonts-noto-cjk dbus-x11 \
 && rm -rf /var/lib/apt/lists/* /tmp/fq.deb
