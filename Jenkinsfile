// Hoga MTS — Jenkins 파이프라인(맥 한 대: iOS 빌드는 macOS가 필요해 Docker Jenkins 대신 Homebrew jenkins-lts)
//
//   Prepare ─▶ ┌ C++ core (일반 · ASan · TSan · JSON vs 이진 벤치)
//              ├ Server   (N-API 애드온 · 애드온 테스트 · vitest(Redis 클러스터 포함) · tsc)
//              ├ App JS   (Jest · tsc · ESLint)
//              ├ Tools    (hoga-cli 테스트 · 앱 버전 일치 확인)
//              ├ iOS      (pod install · xcodebuild)
//              └ Android  (lint · assembleDebug)
//          ─▶ E2E ┌ iOS     (Appium XCUITest)     ← 같은 WebdriverIO 테스트 한 벌
//                 └ Android (Appium UiAutomator2)
//          ─▶ Bench (선택) "JS 경유 vs C++ 직접" 두 플랫폼
//          ─▶ Load  (선택) k6 주문 멱등성 · 시세 팬아웃 · 연결 끊기 복구
//
// 각 단계의 실제 명령은 ci/*.sh 에 있어 Jenkins 없이 터미널에서도 똑같이 돌릴 수 있다.
pipeline {
  agent any

  options {
    timestamps()
    timeout(time: 90, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  parameters {
    booleanParam(name: 'E2E', defaultValue: true, description: 'Appium E2E (부팅된 iOS 시뮬레이터 + Android 에뮬레이터 필요)')
    booleanParam(name: 'BENCH', defaultValue: false, description: '"JS 경유 vs C++ 직접" 비교 실험 (약 4분)')
    booleanParam(name: 'LOAD', defaultValue: false, description: 'k6 부하·장애 시험 (약 2분)')
  }

  environment {
    CI = 'true'
    LANG = 'en_US.UTF-8'
  }

  stages {
    stage('Prepare') {
      steps {
        sh 'rm -rf reports && ci/prepare.sh'
      }
    }

    stage('Build & test') {
      parallel {
        stage('C++ core') { steps { sh 'ci/core.sh' } }
        stage('Server') { steps { sh 'ci/server.sh' } }
        stage('App JS') { steps { sh 'ci/app-js.sh' } }
        stage('Tools') { steps { sh 'ci/tools.sh' } }
        stage('iOS') { steps { sh 'ci/ios.sh' } }
        stage('Android') { steps { sh 'ci/android.sh' } }
      }
    }

    stage('E2E') {
      when { expression { params.E2E } }
      stages {
        stage('Start services') {
          steps {
            // 단계가 끝나도 서버·Metro·Appium이 살아 있도록(post에서 정리)
            withEnv(['JENKINS_NODE_COOKIE=dontKillMe']) { sh 'ci/e2e-services.sh up' }
          }
        }
        stage('Appium') {
          parallel {
            stage('E2E iOS') { steps { sh 'ci/e2e.sh ios' } }
            stage('E2E Android') { steps { sh 'ci/e2e.sh android' } }
          }
        }
        stage('Bench') {
          when { expression { params.BENCH } }
          // 같은 맥에서 두 플랫폼을 동시에 재면 서로 CPU를 빼앗으므로 차례로
          steps {
            sh 'ci/e2e.sh ios specs/bench.e2e.ts'
            sh 'ci/e2e.sh android specs/bench.e2e.ts'
            sh 'mkdir -p reports/bench && cp e2e/reports/bench-*.json reports/bench/'
          }
        }
      }
      post {
        always { sh 'ci/e2e-services.sh down || true' }
      }
    }

    stage('Load') {
      when { expression { params.LOAD } }
      steps { sh 'ci/load.sh' }
    }
  }

  post {
    always {
      junit allowEmptyResults: true, testResults: 'reports/junit/*.xml'
      archiveArtifacts allowEmptyArchive: true, artifacts: [
        'reports/**',
        'e2e/reports/**',
        'apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk',
      ].join(', ')
    }
  }
}
