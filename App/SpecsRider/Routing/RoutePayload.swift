// Copyright © 2026 SpecsRider.
// JSON payload that the Lens consumes via the "route" subscription topic.

import Foundation

struct RoutePoint: Codable, Hashable, Sendable {
    let lat: Double
    let lon: Double
    let meters: Double
}

struct RoutePayload: Codable, Hashable, Sendable {
    let address: String
    let totalMeters: Double
    let sampleSpacingMeters: Double
    let points: [RoutePoint]

    func toJSONData(prettyPrinted: Bool = false) throws -> Data {
        let encoder = JSONEncoder()
        if prettyPrinted {
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        }
        return try encoder.encode(self)
    }

    func toJSONString(prettyPrinted: Bool = false) -> String {
        guard let data = try? toJSONData(prettyPrinted: prettyPrinted),
              let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }
}
