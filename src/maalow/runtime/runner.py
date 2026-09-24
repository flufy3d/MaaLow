from __future__ import annotations

from maalow.workspace import Workspace


class Runner:
    """Loads a workspace pipeline into MaaFramework and runs tasks on a controller."""

    def __init__(self, workspace: Workspace, controller, resource=None):
        from maa.resource import Resource
        from maa.tasker import Tasker

        self.workspace = workspace
        if resource is None:
            resource = Resource()
            resource.post_pipeline(workspace.dir("pipeline")).wait()
            resource.post_image(workspace.dir("templates")).wait()
            if not resource.loaded:
                raise RuntimeError(f"failed to load resources of {workspace.path}")
        self.resource = resource
        self.tasker = Tasker()
        if not self.tasker.bind(self.resource, controller):
            raise RuntimeError("failed to bind tasker")

    def check(self, task: str, image) -> bool:
        """Would this node fire on the given frame? Runs offline, touching no device."""
        from maalow.device.replay import ImageController

        ctrl = ImageController(image)
        ctrl.post_connection().wait()
        return Runner(self.workspace, ctrl, self.resource).run(task, once=True, stop=True)

    def run(self, task: str, once: bool = False, stop: bool = False) -> bool:
        """Run a pipeline entry node; True if it recognized and acted successfully.

        once: check the current screen only, instead of waiting up to the node timeout.
        stop: run just this node, without following its next list.
        """
        override = {task: {**({"timeout": 0} if once else {}), **({"next": []} if stop else {})}}
        detail = self.tasker.post_task(task, override).wait().get()
        return bool(detail and detail.status.succeeded and detail.nodes and detail.nodes[-1].completed)
