import XCTest
@testable import Helmsman

final class InstallArtifactsTests: XCTestCase {
    func test_parse_extractsYamlSecretsAndInstall() {
        let text = """
        Here you go.

        ```yaml
        apiVersion: apps/v1
        kind: Deployment
        ```

        ```secrets
        [
          {"key": "SECRET_KEY", "label": "Django secret key", "description": "Signing key", "kind": "random", "length": 50},
          {"key": "SMTP_PASSWORD", "label": "SMTP password", "description": "Mail relay", "kind": "user", "required": true}
        ]
        ```

        ```install
        {"mode": "helm", "repoName": "plane", "repoURL": "https://helm.plane.so", "chart": "plane-ce", "version": "1.2.3", "releaseName": "plane"}
        ```
        """
        let r = WizardArtifacts.parse(text)
        XCTAssertTrue(r.yaml?.contains("kind: Deployment") ?? false)
        XCTAssertEqual(r.secrets.count, 2)
        XCTAssertEqual(r.secrets[0].key, "SECRET_KEY")
        XCTAssertEqual(r.secrets[0].kind, .random)
        XCTAssertEqual(r.secrets[0].length, 50)
        XCTAssertEqual(r.secrets[1].kind, .user)
        XCTAssertTrue(r.secrets[1].required)
        XCTAssertEqual(r.install?.mode, .helm)
        XCTAssertEqual(r.install?.chart, "plane-ce")
        XCTAssertEqual(r.install?.releaseName, "plane")
    }

    func test_parse_absentBlocks_yieldEmptyAndNil() {
        let text = "```yaml\nkind: Pod\n```"
        let r = WizardArtifacts.parse(text)
        XCTAssertEqual(r.yaml, "kind: Pod")
        XCTAssertTrue(r.secrets.isEmpty)
        XCTAssertNil(r.install)
    }

    func test_parse_unclosedBlock_isIgnored() {
        // A still-streaming (unterminated) secrets fence must not decode.
        let text = "```secrets\n[ {\"key\": \"X\", \"label\": \"x\", \"kind\": \"random\""
        let r = WizardArtifacts.parse(text)
        XCTAssertTrue(r.secrets.isEmpty)
    }

    func test_secretFieldSpec_defaults() throws {
        let json = #"{"key":"K","label":"L","kind":"user"}"#
        let spec = try JSONDecoder().decode(SecretFieldSpec.self, from: Data(json.utf8))
        XCTAssertTrue(spec.required)            // defaults true
        XCTAssertNil(spec.length)
        XCTAssertNil(spec.description)
    }

    func test_installDescriptor_manifestMode() throws {
        let spec = try JSONDecoder().decode(InstallDescriptor.self, from: Data(#"{"mode":"manifest"}"#.utf8))
        XCTAssertEqual(spec.mode, .manifest)
        XCTAssertNil(spec.chart)
    }
}
