FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="${PATH}:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/gradle/bin"

# Install Java 17 and utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk \
    wget \
    unzip \
    ca-certificates \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Install Android SDK command-line tools
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    wget -q \
    https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    -O /tmp/android-tools.zip && \
    unzip -q /tmp/android-tools.zip -d /tmp/android-tools && \
    mkdir -p ${ANDROID_HOME}/cmdline-tools/latest && \
    mv /tmp/android-tools/cmdline-tools/* \
    ${ANDROID_HOME}/cmdline-tools/latest/ && \
    rm -rf /tmp/android-tools /tmp/android-tools.zip

# Install Gradle 8.9
RUN wget -q \
    https://services.gradle.org/distributions/gradle-8.9-bin.zip \
    -O /tmp/gradle.zip && \
    unzip -q /tmp/gradle.zip -d /opt && \
    ln -s /opt/gradle-8.9 /opt/gradle && \
    rm /tmp/gradle.zip

# Install Android SDK packages and accept licenses
RUN yes | sdkmanager --licenses >/dev/null 2>&1 || true

RUN sdkmanager \
    "platform-tools" \
    "platforms;android-35" \
    "build-tools;35.0.0"

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=10000

EXPOSE 10000

CMD ["node", "server.js"]
