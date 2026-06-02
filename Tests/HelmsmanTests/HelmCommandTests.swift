import XCTest
@testable import Helmsman

final class HelmCommandTests: XCTestCase {
    private func helmDescriptor() -> InstallDescriptor {
        try! JSONDecoder().decode(InstallDescriptor.self, from: Data(#"""
        {"mode":"helm","repoName":"plane","repoURL":"https://helm.plane.so","chart":"plane-ce","version":"1.2.3","releaseName":"plane"}
        """#.utf8))
    }

    func test_commands_buildsRepoAddUpdateAndUpgrade() {
        let cmds = HelmCommander.commands(
            descriptor: helmDescriptor(),
            valuesPath: "/tmp/values.yaml",
            namespace: "apps",
            context: "homelab"
        )
        XCTAssertEqual(cmds.count, 3)
        XCTAssertEqual(cmds[0], ["repo", "add", "plane", "https://helm.plane.so"])
        XCTAssertEqual(cmds[1], ["repo", "update", "plane"])
        XCTAssertEqual(cmds[2], [
            "upgrade", "--install", "plane", "plane/plane-ce",
            "--version", "1.2.3",
            "-n", "apps", "--create-namespace",
            "-f", "/tmp/values.yaml",
            "--kube-context", "homelab",
        ])
    }

    func test_commands_omitsContextAndVersionWhenAbsent() {
        let d = try! JSONDecoder().decode(InstallDescriptor.self, from: Data(#"""
        {"mode":"helm","repoName":"r","repoURL":"https://x","chart":"c","releaseName":"rel"}
        """#.utf8))
        let cmds = HelmCommander.commands(descriptor: d, valuesPath: "/tmp/v.yaml", namespace: "default", context: nil)
        XCTAssertFalse(cmds[2].contains("--version"))
        XCTAssertFalse(cmds[2].contains("--kube-context"))
        XCTAssertEqual(cmds[2].first, "upgrade")
    }
}
