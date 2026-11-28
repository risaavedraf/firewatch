FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS build
WORKDIR /src/services/prevention
ENV GOWORK=off CGO_ENABLED=0
COPY services/prevention/go.mod services/prevention/go.sum ./
RUN go mod download && go mod verify
COPY services/prevention/ ./
RUN go build -trimpath -ldflags="-s -w" -o /server ./cmd/server

FROM build AS test
# The contract tests in internal/handler load the published OpenAPI document
# through a repository-relative path, so the test stage has to carry it. Without
# this copy they fail with "no such file or directory" inside the container, and
# the integration job - the only place the database-side rules run - cannot pass.
# The production stages do not need it, which is why it is added here and not in
# the build stage.
COPY contracts/openapi/ /src/contracts/openapi/
# The Keycloak realm tests in internal/directory read the development realm by
# the same repository-relative path, and that document lives under deploy/, which
# the build context keeps out. .dockerignore re-includes this one file, and this
# copy puts it where the path resolves - four levels up from internal/directory -
# so a missing realm still fails the test loudly instead of being skipped. The
# production stages do not need it.
COPY deploy/local/firewatch-realm.json /src/deploy/local/firewatch-realm.json
ENTRYPOINT ["go", "test", "-count=1", "./..."]

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab AS runtime
COPY --from=build /server /server
USER 65532:65532
# The service's own port, fixed by the frozen contract. It is not 8080, which
# belongs to the gateway on the local stack.
EXPOSE 8084
ENTRYPOINT ["/server"]
