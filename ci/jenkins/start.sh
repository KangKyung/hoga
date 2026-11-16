#!/usr/bin/env bash
# 로컬 Jenkins(Homebrew jenkins-lts)를 127.0.0.1:8088에 띄운다(8080은 모의 서버).
# JENKINS_HOME은 저장소 밖(~/.hoga-ci/jenkins). 관리자 비밀번호: $JENKINS_HOME/hoga-admin-password
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CI_HOME="${HOGA_CI_HOME:-$HOME/.hoga-ci}"
export JENKINS_HOME="$CI_HOME/jenkins"
export HOGA_CI_REPO="$CI_HOME/repo.git"
export HOGA_JENKINS_PLUGINS="$HERE/plugins.txt"
mkdir -p "$JENKINS_HOME/init.groovy.d"
cp "$HERE"/init.groovy.d/*.groovy "$JENKINS_HOME/init.groovy.d/"
[ -d "$HOGA_CI_REPO" ] || git init -q --bare "$HOGA_CI_REPO"
if [ ! -f "$JENKINS_HOME/hoga-admin-password" ]; then
  (umask 077 && openssl rand -base64 18 > "$JENKINS_HOME/hoga-admin-password")
fi
# RN 사전 빌드 파일(오프라인 pod install용)
mkdir -p "$CI_HOME/rn-artifacts"
cp -n "$HERE"/../../apps/mobile/ios/Pods/*-artifacts/*-debug.tar.gz "$CI_HOME/rn-artifacts/" 2>/dev/null || true

JAVA="$(brew --prefix openjdk@21)/bin/java"
exec "$JAVA" -Djenkins.install.runSetupWizard=false \
  -Dhudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT=true \
  -jar "$(brew --prefix jenkins-lts)/libexec/jenkins.war" \
  --httpListenAddress=127.0.0.1 --httpPort="${JENKINS_PORT:-8088}"
