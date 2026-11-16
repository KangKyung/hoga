// 첫 실행: plugins.txt의 플러그인을 Jenkins 업데이트 센터에서 설치하고 재시작한다.
import jenkins.model.Jenkins

def jenkins = Jenkins.get()
def wanted = new File(System.getenv('HOGA_JENKINS_PLUGINS')).readLines()*.trim().findAll { it }
def missing = wanted.findAll { jenkins.pluginManager.getPlugin(it) == null }
if (missing) {
  println "hoga: installing plugins ${missing}"
  jenkins.updateCenter.updateAllSites()
  def jobs = missing.collect { jenkins.updateCenter.getPlugin(it).deploy(true) }
  jobs*.get()
  jenkins.safeRestart()
}
