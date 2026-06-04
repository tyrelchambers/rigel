import XCTest
@testable import Helmsman

final class InstallArtifactsTests: XCTestCase {
    func test_parse_extractsYamlAndSecrets() {
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
        """
        let r = WizardArtifacts.parse(text)
        XCTAssertTrue(r.yaml?.contains("kind: Deployment") ?? false)
        XCTAssertEqual(r.secrets.count, 2)
        XCTAssertEqual(r.secrets[0].key, "SECRET_KEY")
        XCTAssertEqual(r.secrets[0].kind, .random)
        XCTAssertEqual(r.secrets[0].length, 50)
        XCTAssertEqual(r.secrets[1].kind, .user)
        XCTAssertTrue(r.secrets[1].required)
    }

    func test_parse_absentSecrets_yieldEmpty() {
        let text = "```yaml\nkind: Pod\n```"
        let r = WizardArtifacts.parse(text)
        XCTAssertEqual(r.yaml, "kind: Pod")
        XCTAssertTrue(r.secrets.isEmpty)
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
        XCTAssertNil(spec.manifest)
        XCTAssertNil(spec.secrets)
    }

    func test_secretFieldSpec_formatDefaultsAlphanumeric_andDecodesHex() throws {
        let plain = try JSONDecoder().decode(SecretFieldSpec.self, from: Data(#"{"key":"K","label":"L","kind":"random"}"#.utf8))
        XCTAssertEqual(plain.format, .alphanumeric)
        let hex = try JSONDecoder().decode(SecretFieldSpec.self, from: Data(#"{"key":"K","label":"L","kind":"random","format":"hex"}"#.utf8))
        XCTAssertEqual(hex.format, .hex)
    }

    // A baked entry must survive a Codable round-trip with its parameterized
    // manifest and typed secret schema intact — that's what catalog.json stores.
    func test_installDescriptor_bakedManifest_roundTrips() throws {
        let descriptor = InstallDescriptor(
            mode: .manifest, repoName: nil, repoURL: nil, chart: nil, version: nil, releaseName: nil,
            manifest: "kind: Secret\nstringData:\n  SECRET_KEY: <FILL_ME_IN>\n",
            values: nil,
            secrets: [
                SecretFieldSpec(key: "SECRET_KEY", label: "Secret key", kind: .random, length: 64, format: .hex),
                SecretFieldSpec(key: "OIDC_CLIENT_ID", label: "OIDC client ID", kind: .user, required: true),
            ]
        )
        let data = try JSONEncoder().encode(descriptor)
        let back = try JSONDecoder().decode(InstallDescriptor.self, from: data)
        XCTAssertEqual(back, descriptor)
        XCTAssertEqual(back.secrets?.count, 2)
        XCTAssertEqual(back.secrets?[0].format, .hex)
        XCTAssertEqual(back.secrets?[0].length, 64)
        XCTAssertEqual(back.secrets?[1].kind, .user)
        XCTAssertTrue(back.manifest?.contains("<FILL_ME_IN>") ?? false)
    }
}
