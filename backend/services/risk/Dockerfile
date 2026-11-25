FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS build
WORKDIR /src/services/risk
ENV GOWORK=off CGO_ENABLED=0
COPY contracts/gen/ /src/contracts/gen/
COPY services/risk/go.mod services/risk/go.sum ./
RUN go mod download && go mod verify
COPY services/risk/ ./
RUN go build -trimpath -ldflags="-s -w" -o /server ./cmd/server

FROM build AS test
# The contract tests in internal/handler load the published OpenAPI document
# through a repository-relative path, so the test stage has to carry it. Without
# this copy they fail with "no such file or directory" inside the container, and
# the integration job - the only place the database-side rules run - cannot pass.
# The production stages do not need it, which is why it is added here and not in
# the build stage.
COPY contracts/openapi/ /src/contracts/openapi/
# Packages are serialized on purpose: every package's tests share this one
# migrated disposable database, and the repository's ordering tests assert which
# stored batch is a zone's newest. Running package test binaries in parallel let
# internal/service publish the same demo zone at wall-clock time while those
# assertions ran, so the effective level was another package's batch and the
# batch identity did not match. `-p 1` removes that cross-package interleaving
# from the test target only; the runtime stage and the other services keep their
# own behaviour.
ENTRYPOINT ["go", "test", "-p", "1", "-count=1", "./..."]

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /server /server
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/server"]
