// 로컬 Jenkins 보안: 관리자 한 명(비밀번호는 start.sh가 만들어 JENKINS_HOME에 0600으로 저장), 익명 읽기 금지.
import jenkins.model.Jenkins
import hudson.security.HudsonPrivateSecurityRealm
import hudson.security.FullControlOnceLoggedInAuthorizationStrategy

def jenkins = Jenkins.get()
def password = new File(jenkins.rootDir, 'hoga-admin-password').text.trim()
def realm = new HudsonPrivateSecurityRealm(false)
if (realm.getUser('admin') == null) realm.createAccount('admin', password)
jenkins.securityRealm = realm
def strategy = new FullControlOnceLoggedInAuthorizationStrategy()
strategy.allowAnonymousRead = false
jenkins.authorizationStrategy = strategy
jenkins.numExecutors = 6 // 병렬 단계 5개 + 여유
jenkins.save()
