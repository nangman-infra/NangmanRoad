def SPOT_AGENT_LABEL = 'spot-agent'
def ONPREM_WATCHTOWER_TRIGGER_AGENT_LABEL = 'onprem-watchtower-trigger'
def PRIMARY_BUILDX_BUILDER = 'default'
def FALLBACK_BUILDX_BUILDER = 'multiarch-builder'
def WEBHOOK_TRIGGER_TOKEN_CREDENTIAL_ID = 'GITHUB_WEBHOOK_TRIGGER_TOKEN'
def REPO_SLUG = 'nangman-infra/NangmanRoad'
def MAIN_BRANCH_REF = 'refs/heads/main'
def DEFAULT_REPO_HTTP_URL = 'https://github.com/nangman-infra/NangmanRoad.git'

pipeline {
    agent none

    triggers {
        GenericTrigger(
            genericVariables: [
                [key: 'GIT_REF', value: '$.ref', defaultValue: ''],
                [key: 'REPO_URL', value: '$.repository.clone_url', defaultValue: ''],
                [key: 'BEFORE_SHA', value: '$.before', defaultValue: ''],
                [key: 'AFTER_SHA', value: '$.after', defaultValue: '']
            ],
            tokenCredentialId: WEBHOOK_TRIGGER_TOKEN_CREDENTIAL_ID,
            causeString: 'NangmanRoad main push detected',
            regexpFilterText: '$REPO_URL $GIT_REF',
            regexpFilterExpression: ".*${REPO_SLUG}.* ${MAIN_BRANCH_REF}",
            printContributedVariables: true,
            printPostContent: true
        )
    }

    environment {
        HARBOR_URL = 'harbor.nangman.cloud'
        HARBOR_PROJECT = 'library'
        HARBOR_CREDS_ID = 'NANGMAN_HARBOR_ROBOT_ACCOUNT'
        IMAGE_NAME = 'nangman-road'
        WATCHTOWER_URL = 'http://172.16.0.37:18081'
        WATCHTOWER_TOKEN = credentials('nangman-personal-web-watchtower-token')
        APP_HEALTH_URL = 'http://172.16.0.37:10004/api/health'
        DEPLOY_TIMEOUT_SECONDS = '180'
        SONARQUBE_INSTALLATION = 'sonarqube'
        SONAR_SCANNER_TOOL = 'SonarScanner'
        SONAR_PROJECT_KEY = 'nangman-road'
        SONAR_PROJECT_NAME = 'nangman-road'
        CI = 'true'
        DOCKER_BUILDKIT = '1'
        DOCKER_CLI_EXPERIMENTAL = 'enabled'
        PLATFORMS = 'linux/amd64,linux/arm64'
    }

    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timeout(time: 60, unit: 'MINUTES')
        timestamps()
        ansiColor('xterm')
    }

    stages {
        stage('Validate And Build On Spot') {
            agent { label SPOT_AGENT_LABEL }
            stages {
                stage('Checkout') {
                    steps {
                        checkout scm
                    }
                }

                stage('Initialize') {
                    steps {
                        script {
                            sh 'git fetch --all --tags --prune'

                            if (env.AFTER_SHA?.trim()) {
                                sh """
                                    if git cat-file -e ${env.AFTER_SHA}^{commit} >/dev/null 2>&1; then
                                        git checkout ${env.AFTER_SHA}
                                    fi
                                """
                            }

                            env.FULL_SHA = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                            env.SHORT_SHA = sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim()
                            env.EXACT_GIT_TAG = sh(
                                script: 'git fetch --tags --force >/dev/null 2>&1 || true; git tag --points-at HEAD | head -n 1',
                                returnStdout: true
                            ).trim()
                            env.BUILD_TIMESTAMP = sh(script: 'date -u +%Y-%m-%dT%H:%M:%SZ', returnStdout: true).trim()
                            env.IMAGE_REPO = "${env.HARBOR_URL}/${env.HARBOR_PROJECT}/${env.IMAGE_NAME}"
                            env.IMAGE_VERSION = env.EXACT_GIT_TAG ?: "sha-${env.SHORT_SHA}"
                            env.IMAGE_REF = "${env.IMAGE_REPO}:${env.IMAGE_VERSION}"
                            env.IMAGE_LATEST = "${env.IMAGE_REPO}:latest"
                            env.IMAGE_SHA = "${env.IMAGE_REPO}:sha-${env.SHORT_SHA}"
                            env.IMAGE_TAGGED = env.EXACT_GIT_TAG ? "${env.IMAGE_REPO}:${env.EXACT_GIT_TAG}" : ''
                            env.IMAGE_CACHE = "${env.IMAGE_REPO}:buildcache"
                            env.BUILD_REF = env.GIT_REF ?: MAIN_BRANCH_REF
                            env.REPO_HTTP_URL = env.REPO_URL?.trim() ? env.REPO_URL.trim() : DEFAULT_REPO_HTTP_URL
                            env.DEPLOY_REQUIRED = 'true'
                            env.FAILURE_CATEGORY = 'build'
                            env.FAILURE_STAGE = 'Initialize'
                            env.FAILURE_REASON = '초기화 단계에서 실패했습니다.'

                            currentBuild.displayName = "#${env.BUILD_NUMBER} ${env.SHORT_SHA}"
                            currentBuild.description = "main -> ${env.IMAGE_VERSION} | ${env.IMAGE_NAME}"

                            echo "Repository: ${env.REPO_HTTP_URL}"
                            echo "Branch ref: ${env.BUILD_REF}"
                            echo "Commit: ${env.FULL_SHA}"
                            echo "Image repository: ${env.IMAGE_REPO}"
                            echo "Image tags: latest, sha-${env.SHORT_SHA}${env.EXACT_GIT_TAG ? ", ${env.EXACT_GIT_TAG}" : ''}"
                            echo "Health check URL: ${env.APP_HEALTH_URL}"
                        }
                    }
                }

                stage('Install Dependencies') {
                    steps {
                        script {
                            env.FAILURE_CATEGORY = 'quality'
                            env.FAILURE_STAGE = 'Install Dependencies'
                            env.FAILURE_REASON = '의존성 설치에 실패했습니다.'
                        }
                        sh '''
                            set -eu
                            node --version
                            npm --version
                            npm ci
                        '''
                    }
                }

                stage('Check / Test / Build') {
                    steps {
                        script {
                            env.FAILURE_CATEGORY = 'quality'
                            env.FAILURE_STAGE = 'Check / Test / Build'
                            env.FAILURE_REASON = '검증 또는 빌드에 실패했습니다.'
                        }
                        sh '''
                            set -eu
                            npm run lint --if-present
                            npm run format --if-present
                            npm run test --if-present
                            npm run check
                            npm run build
                        '''
                    }
                }

                stage('SonarQube Analysis') {
                    steps {
                        script {
                            env.FAILURE_CATEGORY = 'sonar'
                            env.FAILURE_STAGE = 'SonarQube Analysis'
                            env.FAILURE_REASON = 'SonarQube 분석에 실패해 배포가 중단되었습니다.'

                            def scannerHome = tool env.SONAR_SCANNER_TOOL
                            def sourceDirs = ['src', 'server', 'shared', 'scripts'].findAll { path ->
                                fileExists(path)
                            }
                            env.SONAR_SOURCES = sourceDirs ? sourceDirs.join(',') : '.'

                            def coverageLine = fileExists('coverage/lcov.info')
                                ? 'sonar.javascript.lcov.reportPaths=coverage/lcov.info'
                                : ''

                            writeFile(
                                file: 'sonar-project.properties',
                                text: """
                                    sonar.projectKey=${env.SONAR_PROJECT_KEY}
                                    sonar.projectName=${env.SONAR_PROJECT_NAME}
                                    sonar.projectVersion=${env.IMAGE_VERSION}
                                    sonar.projectBaseDir=.
                                    sonar.sourceEncoding=UTF-8
                                    sonar.scm.revision=${env.FULL_SHA}
                                    sonar.sources=${env.SONAR_SOURCES}
                                    sonar.exclusions=**/node_modules/**,**/dist/**,**/dist-server/**,**/coverage/**,**/*.config.*,**/*.d.ts
                                    ${coverageLine}
                                    sonar.javascript.node.maxspace=4096
                                """.stripIndent().trim() + '\n'
                            )

                            withSonarQubeEnv(env.SONARQUBE_INSTALLATION) {
                                sh "\"${scannerHome}/bin/sonar-scanner\" -Dproject.settings=sonar-project.properties"
                            }
                        }
                    }
                }

                stage('Quality Gate') {
                    steps {
                        script {
                            env.FAILURE_CATEGORY = 'sonar'
                            env.FAILURE_STAGE = 'Quality Gate'
                            env.FAILURE_REASON = 'SonarQube 품질 기준을 통과하지 못해 배포가 중단되었습니다.'
                        }
                        timeout(time: 30, unit: 'MINUTES') {
                            waitForQualityGate abortPipeline: true
                        }
                    }
                }

                stage('Setup Buildx') {
                    steps {
                        script {
                            env.FAILURE_CATEGORY = 'build'
                            env.FAILURE_STAGE = 'Setup Buildx'
                            env.FAILURE_REASON = 'Docker buildx 초기화에 실패했습니다.'
                        }
                        sh """
                            docker buildx version

                            if docker buildx inspect ${PRIMARY_BUILDX_BUILDER} >/dev/null 2>&1; then
                                docker buildx use ${PRIMARY_BUILDX_BUILDER}
                                docker buildx inspect ${PRIMARY_BUILDX_BUILDER} --bootstrap
                            else
                                if docker buildx inspect ${FALLBACK_BUILDX_BUILDER} >/dev/null 2>&1; then
                                    docker buildx use ${FALLBACK_BUILDX_BUILDER}
                                else
                                    docker buildx create --name ${FALLBACK_BUILDX_BUILDER} --use --platform "\$PLATFORMS"
                                fi

                                docker buildx inspect ${FALLBACK_BUILDX_BUILDER} --bootstrap
                            fi
                        """
                    }
                }

                stage('Docker Build & Push') {
                    options {
                        timeout(time: 45, unit: 'MINUTES')
                    }
                    steps {
                        script {
                            env.FAILURE_CATEGORY = 'build'
                            env.FAILURE_STAGE = 'Docker Build & Push'
                            env.FAILURE_REASON = 'Docker 이미지 빌드 또는 Harbor 푸시에 실패했습니다.'

                            withCredentials([
                                usernamePassword(
                                    credentialsId: env.HARBOR_CREDS_ID,
                                    usernameVariable: 'HARBOR_USERNAME',
                                    passwordVariable: 'HARBOR_PASSWORD'
                                )
                            ]) {
                                sh 'echo "$HARBOR_PASSWORD" | docker login "$HARBOR_URL" -u "$HARBOR_USERNAME" --password-stdin'
                                try {
                                    def cacheFromArg = sh(
                                        script: "docker buildx imagetools inspect ${env.IMAGE_CACHE} >/dev/null 2>&1",
                                        returnStatus: true
                                    ) == 0 ? "--cache-from type=registry,ref=${env.IMAGE_CACHE}" : ""
                                    def tagArgs = [
                                        "--tag ${env.IMAGE_LATEST}",
                                        "--tag ${env.IMAGE_SHA}"
                                    ]
                                    if (env.EXACT_GIT_TAG) {
                                        tagArgs << "--tag ${env.IMAGE_TAGGED}"
                                    }

                                    def buildArgs = [
                                        "--platform ${env.PLATFORMS}",
                                    ] + tagArgs
                                    if (cacheFromArg) {
                                        buildArgs << cacheFromArg
                                    }
                                    buildArgs += [
                                        "--cache-to type=registry,ref=${env.IMAGE_CACHE},mode=max",
                                        "--label org.opencontainers.image.created=${env.BUILD_TIMESTAMP}",
                                        "--label org.opencontainers.image.revision=${env.FULL_SHA}",
                                        "--label org.opencontainers.image.source=${env.REPO_HTTP_URL}",
                                        "--label org.opencontainers.image.version=${env.IMAGE_VERSION}",
                                        "--pull",
                                        "--push",
                                        "--progress=plain",
                                        "."
                                    ]

                                    sh """
                                        docker buildx build \\
                                            ${buildArgs.join(' \\\n                                            ')}
                                    """
                                } finally {
                                    sh 'docker logout "$HARBOR_URL"'
                                }
                            }
                        }
                    }
                }

                stage('Verify Images') {
                    steps {
                        script {
                            env.FAILURE_CATEGORY = 'build'
                            env.FAILURE_STAGE = 'Verify Images'
                            env.FAILURE_REASON = 'Harbor에 푸시된 이미지 검증에 실패했습니다.'
                        }
                        withCredentials([
                            usernamePassword(
                                credentialsId: env.HARBOR_CREDS_ID,
                                usernameVariable: 'HARBOR_USERNAME',
                                passwordVariable: 'HARBOR_PASSWORD'
                            )
                        ]) {
                            sh '''
                                set -eu
                                echo "$HARBOR_PASSWORD" | docker login "$HARBOR_URL" -u "$HARBOR_USERNAME" --password-stdin

                                echo "Inspecting latest manifest"
                                docker buildx imagetools inspect "$IMAGE_LATEST"

                                echo "Inspecting sha manifest"
                                docker buildx imagetools inspect "$IMAGE_SHA"

                                if [ -n "${IMAGE_TAGGED:-}" ]; then
                                    echo "Inspecting git tag manifest"
                                    docker buildx imagetools inspect "$IMAGE_TAGGED"
                                fi

                                docker logout "$HARBOR_URL"
                            '''
                        }
                    }
                }
            }
        }

        stage('Deploy On Onprem') {
            agent { label ONPREM_WATCHTOWER_TRIGGER_AGENT_LABEL }
            when {
                expression { env.DEPLOY_REQUIRED == 'true' }
            }
            stages {
                stage('Trigger Watchtower') {
                    steps {
                        script {
                            env.FAILURE_CATEGORY = 'deploy'
                            env.FAILURE_STAGE = 'Trigger Watchtower'
                            env.FAILURE_REASON = 'Watchtower 배포 트리거 호출에 실패했습니다.'
                        }
                        sh '''
                            set -eu

                            response=$(curl -sS -w "\\n%{http_code}" \
                                -H "Authorization: Bearer $WATCHTOWER_TOKEN" \
                                "$WATCHTOWER_URL/v1/update")

                            http_code=$(echo "$response" | tail -n1)
                            body=$(echo "$response" | sed '$d')

                            if [ "$http_code" -eq 200 ]; then
                                echo "Watchtower update triggered successfully"
                                echo "Response: $body"
                            else
                                echo "Failed to trigger Watchtower update"
                                echo "HTTP Code: $http_code"
                                echo "Response: $body"
                                exit 1
                            fi
                        '''
                    }
                }

                stage('Verify Deployment') {
                    steps {
                        script {
                            env.FAILURE_CATEGORY = 'deploy'
                            env.FAILURE_STAGE = 'Verify Deployment'
                            env.FAILURE_REASON = '배포 후 health check에 실패했습니다.'
                        }
                        sh '''
                            set -eu
                            deadline=$(( $(date +%s) + DEPLOY_TIMEOUT_SECONDS ))

                            while [ "$(date +%s)" -lt "$deadline" ]; do
                                if curl -fsS "$APP_HEALTH_URL" >/tmp/nangman-road-health-response.txt; then
                                    echo "Deployment verified at $APP_HEALTH_URL"
                                    head -c 500 /tmp/nangman-road-health-response.txt || true
                                    exit 0
                                fi

                                sleep 5
                            done

                            echo "Deployment verification timed out after ${DEPLOY_TIMEOUT_SECONDS}s"
                            exit 1
                        '''
                    }
                }
            }
        }
    }

    post {
        success {
            mattermostSend(
                color: 'good',
                message: ":tada: Nangman Road 배포가 완료되었습니다.\n프로젝트: ${env.JOB_NAME} #${env.BUILD_NUMBER}\n이미지: ${env.IMAGE_REF}\n바로가기: ${env.BUILD_URL}"
            )
        }

        failure {
            mattermostSend(
                color: 'danger',
                message: ":rotating_light: Nangman Road 빌드/배포 실패.\n실패 단계: ${env.FAILURE_STAGE}\n사유: ${env.FAILURE_REASON}\n프로젝트: ${env.JOB_NAME} #${env.BUILD_NUMBER}\n바로가기: ${env.BUILD_URL}"
            )
        }

        always {
            echo '빌드 완료. Buildx는 이미지를 직접 푸시하므로 로컬 이미지 정리가 불필요합니다.'
        }
    }
}
