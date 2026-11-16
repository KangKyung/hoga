// 파이프라인 잡 "hoga": 로컬 CI 저장소(snapshot.sh가 작업 트리를 올린 곳)의 ci 브랜치 Jenkinsfile을 쓴다.
import jenkins.model.Jenkins
import hudson.plugins.git.GitSCM
import hudson.plugins.git.BranchSpec
import hudson.plugins.git.UserRemoteConfig
import org.jenkinsci.plugins.workflow.job.WorkflowJob
import org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition

def jenkins = Jenkins.get()
if (jenkins.pluginManager.getPlugin('workflow-job') == null || jenkins.pluginManager.getPlugin('git') == null) return
def repo = System.getenv('HOGA_CI_REPO')
def job = jenkins.getItem('hoga') ?: jenkins.createProject(WorkflowJob, 'hoga')
def scm = new GitSCM([new UserRemoteConfig("file://${repo}", null, null, null)], [new BranchSpec('*/ci')], null, null, [])
def definition = new CpsScmFlowDefinition(scm, 'Jenkinsfile')
definition.lightweight = true
job.definition = definition
job.description = 'Hoga MTS: C++ · 서버 · JS · iOS · Android 병렬 + Appium E2E(두 플랫폼)'
job.save()
